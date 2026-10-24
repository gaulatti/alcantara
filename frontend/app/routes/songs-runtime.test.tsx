import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Provider } from "react-redux";
import { legacy_createStore } from "redux";
import { MemoryRouter } from "react-router";
import { ConsolePreferencesProvider } from "../contexts/ConsolePreferencesContext";
import { reducers } from "../state/reducers";
import type { InstantItem, SongCatalogItem } from "../models/broadcast";
import Songs, { meta } from "./songs";

// Only session, HTTP, file-metadata and media playback are external fixtures.
// The route, services, Redux preferences, modal and editor widgets remain real.
vi.mock("../services/session", () => ({
  getAppSession: async () => ({ token: "songs-fixture-session" }),
}));
vi.mock("../utils/apiBaseUrl", () => ({
  getApiBaseUrl: () => "https://songs.example.invalid",
  apiUrl: (path: string) => `https://songs.example.invalid${path}`,
}));

type RequestRecord = {
  method: string;
  url: URL;
  body: unknown;
  headers: Headers;
};
type Failure = {
  method: string;
  path: string;
  status?: number;
  text?: string;
  thrown?: unknown;
};
let records: RequestRecord[];
let catalog: SongCatalogItem[];
let instants: InstantItem[];
let failures: Failure[];
let uploadResults: unknown[];
let durationResults: (number | "error")[];
let rejectPlayback: boolean;
let selectedProgram: string;
let paginated: boolean;
let unexpected: string[];
const originalShow = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "showModal",
);
const originalClose = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "close",
);
const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

class FixtureAudio {
  static instances: FixtureAudio[] = [];
  preload = "";
  duration = 0;
  onloadedmetadata: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onended: (() => void) | null = null;
  play = vi.fn(() =>
    rejectPlayback
      ? Promise.reject(new Error("playback denied"))
      : Promise.resolve(),
  );
  constructor(public src = "") {
    FixtureAudio.instances.push(this);
  }
  load() {
    const value = durationResults.shift() ?? 3.25;
    this.duration = typeof value === "number" ? value : 0;
    queueMicrotask(() =>
      value === "error" ? this.onerror?.() : this.onloadedmetadata?.(),
    );
  }
}

function song(
  id = 1,
  overrides: Partial<SongCatalogItem> = {},
): SongCatalogItem {
  return {
    id,
    artist: "Catalog artist",
    title: "Opening song",
    audioUrl: `https://media.example.invalid/song-${id}.mp3`,
    coverUrl: "https://media.example.invalid/cover.jpg",
    durationMs: 125000,
    earoneSongId: "ear-123",
    earoneRank: "4",
    earoneSpins: "17",
    enabled: true,
    createdAt: "2026-10-24T10:00:00Z",
    updatedAt: "2026-10-24T12:00:00Z",
    ...overrides,
  };
}
const response = (body: unknown, status = 200) =>
  Response.json(body, { status });
async function transport(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body =
    init?.body instanceof FormData
      ? init.body
      : init?.body
        ? JSON.parse(String(init.body))
        : null;
  records.push({ method, url, body, headers: new Headers(init?.headers) });
  const failure = failures.find(
    (f) => f.method === method && f.path === url.pathname,
  );
  if (failure) {
    if ("thrown" in failure) throw failure.thrown;
    return new Response(failure.text ?? "", { status: failure.status ?? 500 });
  }
  if (url.pathname.startsWith("/operator-preferences/"))
    return response({
      version: 1,
      profile: {
        workspace: "director",
        dockWidth: 320,
        touchMode: false,
        shortcutsEnabled: true,
        selectedProgramId: selectedProgram,
        transitions: { main: "cut" },
      },
    });
  if (url.pathname === "/instants") return response(instants);
  if (url.pathname === "/songs" && method === "GET") {
    let data = catalog;
    const search = url.searchParams.get("search")?.toLowerCase();
    if (search)
      data = data.filter((item) =>
        `${item.artist} ${item.title} ${item.earoneSongId}`
          .toLowerCase()
          .includes(search),
      );
    if (url.searchParams.get("enabled") === "true")
      data = data.filter((item) => item.enabled);
    if (paginated)
      data = data.slice(
        Number(url.searchParams.get("page") ?? 1) - 1,
        Number(url.searchParams.get("page") ?? 1),
      );
    return response({
      data,
      meta: {
        page: Number(url.searchParams.get("page") ?? 1),
        limit: 50,
        total: paginated ? 51 : data.length,
        totalPages: paginated ? 2 : 1,
        catalogTotal: paginated ? 51 : catalog.length,
        catalogEnabled: catalog.filter((item) => item.enabled).length,
        catalogTotalDurationMs: catalog.reduce(
          (total, item) => total + (item.durationMs ?? 0),
          0,
        ),
        catalogKnownDurationCount: catalog.filter(
          (item) => (item.durationMs ?? 0) > 0,
        ).length,
      },
    });
  }
  if (url.pathname.startsWith("/uploads/") && method === "POST")
    return response(
      uploadResults.shift() ?? {
        url: "https://media.example.invalid/uploaded.mp3",
      },
    );
  if (url.pathname === "/songs" && method === "POST") {
    catalog.push(song(catalog.length + 1, body as Partial<SongCatalogItem>));
    return response(catalog.at(-1), 201);
  }
  const id = Number(url.pathname.match(/^\/songs\/(\d+)$/)?.[1]);
  if (id && method === "PUT") {
    catalog = catalog.map((item) =>
      item.id === id
        ? { ...item, ...(body as Partial<SongCatalogItem>) }
        : item,
    );
    return response(catalog.find((item) => item.id === id));
  }
  if (id && method === "DELETE") {
    catalog = catalog.filter((item) => item.id !== id);
    return response({ deleted: true });
  }
  unexpected.push(`${method} ${url.pathname}`);
  throw new Error(`Unexpected fixture request: ${method} ${url.pathname}`);
}
const calls = (method: string, path: string) =>
  records.filter((r) => r.method === method && r.url.pathname === path);
beforeEach(() => {
  records = [];
  failures = [];
  uploadResults = [];
  durationResults = [];
  unexpected = [];
  rejectPlayback = false;
  selectedProgram = "main";
  paginated = false;
  catalog = [song()];
  instants = [
    {
      id: 7,
      name: "Available voice intro",
      audioUrl: "https://media.example.invalid/intro.mp3",
      volume: 0.8,
      position: 0,
      enabled: true,
      availableForSongIntro: true,
    },
    {
      id: 8,
      name: "Already assigned intro",
      audioUrl: "https://media.example.invalid/assigned.mp3",
      volume: 1,
      position: 1,
      enabled: true,
      availableForSongIntro: false,
      assignedSongId: 99,
    },
    {
      id: 9,
      name: "Disabled intro",
      audioUrl: "https://media.example.invalid/disabled.mp3",
      volume: 1,
      position: 2,
      enabled: false,
    },
  ];
  FixtureAudio.instances = [];
  localStorage.clear();
  vi.stubGlobal("innerWidth", 1600);
  vi.stubGlobal("fetch", vi.fn(transport));
  vi.stubGlobal("Audio", FixtureAudio);
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:songs-metadata-fixture"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(async () => {
  for (const button of screen.queryAllByRole("button", { name: "Close alert" }))
    fireEvent.click(button);
  await waitFor(() =>
    expect(
      screen.queryAllByRole("button", { name: "Close alert" }),
    ).toHaveLength(0),
  );
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [object, name, descriptor] of [
    [HTMLDialogElement.prototype, "showModal", originalShow],
    [HTMLDialogElement.prototype, "close", originalClose],
    [URL, "createObjectURL", originalCreate],
    [URL, "revokeObjectURL", originalRevoke],
  ] as const) {
    if (descriptor) Object.defineProperty(object, name, descriptor);
    else Reflect.deleteProperty(object, name);
  }
  expect(unexpected).toEqual([]);
});

async function mount() {
  const store = legacy_createStore(reducers);
  store.dispatch({
    type: "LOGIN",
    payload: { id: "songs-operator", email: "operator@example.invalid" },
  });
  render(
    <Provider store={store}>
      <MemoryRouter>
        <ConsolePreferencesProvider>
          <Songs />
        </ConsolePreferencesProvider>
      </MemoryRouter>
    </Provider>,
  );
  await waitFor(() =>
    expect(
      calls("GET", "/songs").some(
        (r) => r.url.searchParams.get("programId") === selectedProgram,
      ),
    ).toBe(true),
  );
  await waitFor(() =>
    expect(screen.queryByText("Loading songs...")).not.toBeInTheDocument(),
  );
}
async function edit(id = 1) {
  const item = catalog.find((entry) => entry.id === id)!;
  const title =
    `${item.artist.trim()}${item.artist.trim() && item.title.trim() ? " - " : ""}${item.title.trim()}` ||
    "Untitled song";
  fireEvent.click(screen.getByRole("button", { name: `Edit ${title}` }));
  return screen.findByRole("dialog", { name: "Edit song" });
}
function field(dialog: HTMLElement, label: string) {
  const element = within(dialog)
    .getByText(label, { selector: "label" })
    .parentElement?.querySelector("input");
  if (!element) throw new Error(`Visible field missing: ${label}`);
  return element;
}
const change = (dialog: HTMLElement, label: string, value: string) =>
  fireEvent.change(field(dialog, label), { target: { value } });
const fileInput = (dialog: HTMLElement, accept: string) =>
  dialog.querySelector(
    `input[type="file"][accept="${accept}"]`,
  ) as HTMLInputElement;

it("renders the actual catalog, active program, native metadata and both responsive action surfaces", async () => {
  selectedProgram = "evening";
  await mount();
  expect(
    screen.getByRole("heading", { name: "Song catalog" }),
  ).toBeInTheDocument();
  expect(screen.getAllByText("Opening song")).toHaveLength(2);
  expect(screen.getAllByText("2:05").length).toBeGreaterThan(0);
  expect(screen.getByText("1 enabled")).toBeInTheDocument();
  expect(screen.getByText("1 with known runtime")).toBeInTheDocument();
  expect(
    calls("GET", "/instants").some(
      (r) => r.url.searchParams.get("programId") === "evening",
    ),
  ).toBe(true);
  expect(meta({} as Parameters<typeof meta>[0])).toContainEqual({
    title: "Songs - TV Broadcast",
  });
});

it.each([
  { artist: "", title: "", durationMs: null, coverUrl: null },
  { artist: "Only artist", title: "", durationMs: 0, coverUrl: null },
  { artist: "", title: "Only title", durationMs: -10, coverUrl: null },
])(
  "keeps incomplete legacy catalog presentation explicit: %j",
  async (values) => {
    catalog = [song(1, values)];
    await mount();
    expect(screen.getAllByText(values.title || "Untitled")).toHaveLength(2);
    expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
    const dialog = await edit();
    expect(field(dialog, "Artist")).toHaveValue(values.artist);
  },
);

it("debounces text search and forwards exact artist, title or external-ID search to the real service", async () => {
  catalog.push(
    song(2, { artist: "Second artist", title: "Closing song", enabled: false }),
  );
  await mount();
  fireEvent.change(
    screen.getByPlaceholderText("Search by artist, title, or EarOne ID"),
    { target: { value: "Closing" } },
  );
  expect(calls("GET", "/songs").at(-1)?.url.searchParams.has("search")).toBe(
    false,
  );
  await waitFor(() =>
    expect(calls("GET", "/songs").at(-1)?.url.searchParams.get("search")).toBe(
      "Closing",
    ),
  );
  expect(screen.queryByText("Opening song")).not.toBeInTheDocument();
  expect(screen.getAllByText("Closing song")).toHaveLength(2);
});

it("filters by the clicked artist and excludes disabled songs only when requested", async () => {
  catalog.push(
    song(2, { artist: "Other artist", title: "Disabled song", enabled: false }),
  );
  await mount();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Show disabled songs" }),
  );
  await waitFor(() =>
    expect(calls("GET", "/songs").at(-1)?.url.searchParams.get("enabled")).toBe(
      "true",
    ),
  );
  expect(screen.queryByText("Disabled song")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Catalog artist" }));
  await waitFor(() =>
    expect(calls("GET", "/songs").at(-1)?.url.searchParams.get("search")).toBe(
      "Catalog artist",
    ),
  );
});

it("sorts a new field ascending and toggles the active header in both directions", async () => {
  await mount();
  for (const [label, expectedField, expectedOrder] of [
    ["Artist", "artist", "desc"],
    ["Artist", "artist", "asc"],
    ["Title", "title", "asc"],
    ["Duration", "durationMs", "asc"],
  ] as const) {
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() =>
      expect(
        calls("GET", "/songs").at(-1)?.url.searchParams.get("sortBy"),
      ).toBe(expectedField),
    );
    expect(
      calls("GET", "/songs").at(-1)?.url.searchParams.get("sortOrder"),
    ).toBe(expectedOrder);
  }
});

it("changes server pages and resets pagination when a filter changes", async () => {
  paginated = true;
  catalog.push(song(2, { title: "Second-page song" }));
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() =>
    expect(calls("GET", "/songs").at(-1)?.url.searchParams.get("page")).toBe(
      "2",
    ),
  );
  expect(screen.getAllByText("Second-page song")).toHaveLength(2);
  expect(screen.getByText(/#51/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Title" }));
  await waitFor(() =>
    expect(calls("GET", "/songs").at(-1)?.url.searchParams.get("page")).toBe(
      "1",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() =>
    expect(calls("GET", "/songs").at(-1)?.url.searchParams.get("page")).toBe(
      "2",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
  await waitFor(() =>
    expect(calls("GET", "/songs").at(-1)?.url.searchParams.get("page")).toBe(
      "1",
    ),
  );
});

it("distinguishes an empty catalog from a filtered empty view and clears filters through the displayed action", async () => {
  await mount();
  fireEvent.change(
    screen.getByPlaceholderText("Search by artist, title, or EarOne ID"),
    { target: { value: "no match" } },
  );
  await screen.findByText("No songs match this search");
  fireEvent.click(screen.getByRole("button", { name: "Clear Filters" }));
  await screen.findAllByText("Opening song");
});

it("opens the actual batch-upload modal from an empty catalog and cancels without a mutation", async () => {
  catalog = [];
  await mount();
  expect(screen.getByText("No songs yet")).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: "Add song" })[1]);
  const dialog = await screen.findByRole("dialog", { name: "Add song" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(calls("POST", "/songs")).toHaveLength(0);
});

it.each([403, 500])(
  "shows a catalog-loading failure for HTTP%s without inventing song data",
  async (status) => {
    failures.push({ method: "GET", path: "/songs", status });
    await mount();
    expect(
      await screen.findByText("Failed to load songs catalog."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Opening song")).not.toBeInTheDocument();
  },
);

it("reports an unavailable intro catalog while leaving song editing available", async () => {
  failures.push({ method: "GET", path: "/instants", status: 403 });
  await mount();
  expect(
    await screen.findByText("Failed to load audio clips for song intros."),
  ).toBeInTheDocument();
  const dialog = await edit();
  expect(
    within(dialog).getByRole("combobox", { name: "Assigned song intro" }),
  ).toHaveValue("");
});

it("previews catalog audio through the browser media boundary without taking anything on air", async () => {
  await mount();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Preview Catalog artist - Opening song",
    }),
  );
  await waitFor(() => expect(FixtureAudio.instances).toHaveLength(1));
  expect(FixtureAudio.instances[0].src).toBe(catalog[0].audioUrl);
  expect(FixtureAudio.instances[0].preload).toBe("auto");
  expect(FixtureAudio.instances[0].play).toHaveBeenCalledTimes(1);
  expect(records.filter((r) => r.method !== "GET")).toHaveLength(0);
});

it("surfaces preview playback failure without removing the catalog item", async () => {
  rejectPlayback = true;
  await mount();
  fireEvent.click(
    within(screen.getByRole("article")).getByRole("button", {
      name: "Preview",
    }),
  );
  expect(
    await screen.findByText("Failed to play song preview."),
  ).toBeInTheDocument();
  expect(screen.getAllByText("Opening song")).toHaveLength(2);
});

it("saves trimmed editorial fields, nullable metadata, enabled state and the active program together", async () => {
  selectedProgram = "evening";
  await mount();
  const dialog = await edit();
  change(dialog, "Artist", " Revised artist ");
  change(dialog, "Title", " Revised title ");
  change(dialog, "Audio URL", " https://media.example.invalid/revised.mp3 ");
  change(dialog, "Cover URL", "");
  change(dialog, "Duration (ms)", "1234.6");
  change(dialog, "EarOne Song ID", " ");
  change(dialog, "EarOne Rank", " 9 ");
  change(dialog, "EarOne Spins", "");
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Enabled" }));
  fireEvent.change(
    within(dialog).getByRole("combobox", { name: "Assigned song intro" }),
    { target: { value: "7" } },
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Update Song" }));
  await waitFor(() => expect(calls("PUT", "/songs/1")).toHaveLength(1));
  expect(calls("PUT", "/songs/1")[0].body).toEqual({
    artist: "Revised artist",
    title: "Revised title",
    audioUrl: "https://media.example.invalid/revised.mp3",
    coverUrl: null,
    durationMs: 1235,
    earoneSongId: null,
    earoneRank: "9",
    earoneSpins: null,
    enabled: false,
    programId: "evening",
    introInstantId: 7,
  });
  await screen.findAllByText("Revised title");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.getByText("Song updated.")).toBeInTheDocument();
});

it.each([
  ["Audio URL", "", "Audio URL is required. Upload a song file first."],
  ["Artist and title", "", "Artist or title is required."],
  ["Duration (ms)", "0", "Duration must be a positive number in milliseconds."],
  [
    "Duration (ms)",
    "-20",
    "Duration must be a positive number in milliseconds.",
  ],
])(
  "rejects invalid %s before mutating the catalog",
  async (label, value, message) => {
    await mount();
    const dialog = await edit();
    if (label === "Artist and title") {
      change(dialog, "Artist", " ");
      change(dialog, "Title", " ");
    } else change(dialog, label, value);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Update Song" }),
    );
    expect(within(dialog).getByText(message)).toBeInTheDocument();
    expect(calls("PUT", "/songs/1")).toHaveLength(0);
  },
);

it("retains empty duration and an artist-only identity without inventing runtime or an intro", async () => {
  await mount();
  const dialog = await edit();
  change(dialog, "Title", "");
  change(dialog, "Duration (ms)", "");
  fireEvent.click(within(dialog).getByRole("button", { name: "Update Song" }));
  await waitFor(() => expect(calls("PUT", "/songs/1")).toHaveLength(1));
  expect(calls("PUT", "/songs/1")[0].body).toMatchObject({
    title: "",
    durationMs: null,
    introInstantId: null,
  });
});

it.each([
  [JSON.stringify({ message: "Permission denied" }), "Permission denied"],
  [
    JSON.stringify({
      message: ["Invalid audio URL", "", 3, "Intro unavailable"],
    }),
    "Invalid audio URL, Intro unavailable",
  ],
  ["upstream plain-text failure", "upstream plain-text failure"],
  ["", "HTTP 403"],
  [JSON.stringify({ message: [] }), JSON.stringify({ message: [] })],
])(
  "keeps an edit open and displays the actual rejected save diagnosis %j",
  async (text, expected) => {
    failures.push({ method: "PUT", path: "/songs/1", status: 403, text });
    await mount();
    const dialog = await edit();
    change(dialog, "Title", "Unaccepted change");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Update Song" }),
    );
    expect(await within(dialog).findByText(expected)).toBeInTheDocument();
    expect(field(dialog, "Title")).toHaveValue("Unaccepted change");
    expect(catalog[0].title).toBe("Opening song");
  },
);

it("reports an untyped transport failure with the safe save message", async () => {
  failures.push({
    method: "PUT",
    path: "/songs/1",
    thrown: "transport failed",
  });
  await mount();
  const dialog = await edit();
  fireEvent.click(within(dialog).getByRole("button", { name: "Update Song" }));
  expect(
    await within(dialog).findByText("Failed to save song."),
  ).toBeInTheDocument();
});

it("cancels unsaved edits and reopens from authoritative song data", async () => {
  await mount();
  let dialog = await edit();
  change(dialog, "Title", "Unsaved title");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  dialog = await edit();
  expect(field(dialog, "Title")).toHaveValue("Opening song");
  expect(calls("PUT", "/songs/1")).toHaveLength(0);
});

it("requires confirmation before deletion and keeps cancellation side-effect free", async () => {
  vi.mocked(confirm).mockReturnValue(false);
  await mount();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Delete Catalog artist - Opening song",
    }),
  );
  expect(confirm).toHaveBeenCalledWith(
    'Delete song "Catalog artist - Opening song"?',
  );
  expect(calls("DELETE", "/songs/1")).toHaveLength(0);
});

it("deletes the selected item through the responsive card action and refreshes the catalog", async () => {
  await mount();
  fireEvent.click(
    within(screen.getByRole("article")).getByRole("button", { name: "Delete" }),
  );
  await screen.findByText("Song deleted.");
  expect(calls("DELETE", "/songs/1")).toHaveLength(1);
  expect(screen.getByText("No songs yet")).toBeInTheDocument();
});

it("keeps a rejected deletion visible and shows the failure without a fabricated removal", async () => {
  failures.push({
    method: "DELETE",
    path: "/songs/1",
    status: 409,
    text: "Song still referenced",
  });
  await mount();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Delete Catalog artist - Opening song",
    }),
  );
  expect(await screen.findByText("Failed to delete song.")).toBeInTheDocument();
  expect(screen.getAllByText("Opening song")).toHaveLength(2);
});

it("assigns only available intros, explains removal, and plays the referenced recording", async () => {
  catalog[0].intro = {
    id: 1,
    songId: 1,
    instantId: 7,
    programId: "main",
    instant: instants[0],
  };
  await mount();
  const dialog = await edit();
  const select = within(dialog).getByRole("combobox", {
    name: "Assigned song intro",
  });
  expect(select).toHaveValue("7");
  expect(
    within(select).getByRole("option", {
      name: "Already assigned intro — unavailable",
    }),
  ).toBeDisabled();
  expect(
    within(select).getByRole("option", {
      name: "Disabled intro — unavailable",
    }),
  ).toBeDisabled();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Preview intro" }),
  );
  expect(FixtureAudio.instances.at(-1)?.src).toBe(instants[0].audioUrl);
  expect(
    within(dialog).getByRole("button", { name: "Previewing…" }),
  ).toBeDisabled();
  act(() => FixtureAudio.instances.at(-1)?.onended?.());
  fireEvent.change(select, { target: { value: "" } });
  expect(
    within(dialog).getByText(
      "Saving removes the current song intro assignment.",
    ),
  ).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Update Song" }));
  await waitFor(() =>
    expect(calls("PUT", "/songs/1")[0]?.body).toMatchObject({
      introInstantId: null,
    }),
  );
});

it.each(["error", "reject"] as const)(
  "clears an intro preview after browser playback %s",
  async (mode) => {
    await mount();
    const dialog = await edit();
    fireEvent.change(
      within(dialog).getByRole("combobox", { name: "Assigned song intro" }),
      { target: { value: "7" } },
    );
    rejectPlayback = mode === "reject";
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Preview intro" }),
    );
    if (mode === "error") act(() => FixtureAudio.instances.at(-1)?.onerror?.());
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Preview intro" }),
      ).toBeEnabled(),
    );
  },
);

it("uploads a batch through authenticated multipart and creates songs from actual returned metadata", async () => {
  uploadResults = [
    {
      url: "https://media.example.invalid/new.mp3",
      metadata: {
        artist: " Uploaded artist ",
        title: " Uploaded title ",
        coverUrl: " https://media.example.invalid/new.jpg ",
        durationMs: 2345.6,
      },
    },
  ];
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Add song" }));
  const dialog = await screen.findByRole("dialog", { name: "Add song" });
  const file = new File(["fictional audio"], "upload.mp3", {
    type: "audio/mpeg",
  });
  fireEvent.change(fileInput(dialog, "audio/*"), { target: { files: [file] } });
  await within(dialog).findByRole("button", { name: "Done" });
  expect(calls("POST", "/uploads/song")[0].headers.get("Authorization")).toBe(
    "Bearer songs-fixture-session",
  );
  expect((calls("POST", "/uploads/song")[0].body as FormData).get("file")).toBe(
    file,
  );
  expect(calls("POST", "/songs")[0].body).toEqual({
    artist: "Uploaded artist",
    title: "Uploaded title",
    audioUrl: "https://media.example.invalid/new.mp3",
    coverUrl: "https://media.example.invalid/new.jpg",
    durationMs: 2346,
    enabled: true,
  });
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(
    "blob:songs-metadata-fixture",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  await screen.findAllByText("Uploaded title");
});

it.each([3.25, 0, Infinity, "error"] as const)(
  "uses file metadata fallback honestly when uploaded metadata has no duration: %s",
  async (duration) => {
    durationResults = [duration];
    uploadResults = [
      {
        url: "https://media.example.invalid/new.mp3",
        metadata: { artist: " ", title: 42, coverUrl: null, durationMs: -1 },
      },
    ];
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Add song" }));
    const dialog = await screen.findByRole("dialog", { name: "Add song" });
    fireEvent.change(fileInput(dialog, "audio/*"), {
      target: {
        files: [
          new File(["audio"], "Filename fallback.wav", { type: "audio/wav" }),
        ],
      },
    });
    await within(dialog).findByRole("button", { name: "Done" });
    expect(calls("POST", "/songs")[0].body).toMatchObject({
      artist: "Filename fallback",
      title: "",
      coverUrl: null,
      durationMs: duration === 3.25 ? 3250 : null,
    });
  },
);

it("keeps independent batch failure and success outcomes and refreshes only actual successes", async () => {
  uploadResults = [
    { url: "https://media.example.invalid/first.mp3" },
    { url: "https://media.example.invalid/second.mp3" },
  ];
  let count = 0;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (
      String(input).endsWith("/songs") &&
      init?.method === "POST" &&
      ++count === 1
    ) {
      records.push({
        method: "POST",
        url: new URL(String(input)),
        body: JSON.parse(String(init.body)),
        headers: new Headers(init.headers),
      });
      return response({ message: ["Invalid recording", "Rejected"] }, 400);
    }
    return transport(input, init);
  });
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Add song" }));
  const dialog = await screen.findByRole("dialog", { name: "Add song" });
  fireEvent.change(fileInput(dialog, "audio/*"), {
    target: {
      files: [
        new File(["bad"], "rejected.mp3"),
        new File(["ok"], "accepted.mp3"),
      ],
    },
  });
  await within(dialog).findByRole("button", { name: "Done" });
  expect(
    within(dialog).getByText("Invalid recording, Rejected"),
  ).toBeInTheDocument();
  expect(catalog.some((item) => item.artist === "accepted")).toBe(true);
  expect(catalog.some((item) => item.artist === "rejected")).toBe(false);
});

it("surfaces a denied batch upload and does not attempt song creation", async () => {
  failures.push({
    method: "POST",
    path: "/uploads/song",
    status: 403,
    text: "Upload not authorized",
  });
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Add song" }));
  const dialog = await screen.findByRole("dialog", { name: "Add song" });
  fireEvent.change(fileInput(dialog, "audio/*"), {
    target: { files: [new File(["audio"], "denied.mp3")] },
  });
  await within(dialog).findByRole("button", { name: "Done" });
  expect(within(dialog).getByText("Upload not authorized")).toBeInTheDocument();
  expect(calls("POST", "/songs")).toHaveLength(0);
});

it("uploads cover artwork through its own route and persists the returned producer URL", async () => {
  uploadResults = [{ url: "https://media.example.invalid/new-artwork.png" }];
  await mount();
  const dialog = await edit();
  fireEvent.change(fileInput(dialog, "image/*"), {
    target: {
      files: [new File(["image"], "cover.png", { type: "image/png" })],
    },
  });
  await waitFor(() =>
    expect(field(dialog, "Cover URL")).toHaveValue(
      "https://media.example.invalid/new-artwork.png",
    ),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Update Song" }));
  await waitFor(() =>
    expect(calls("PUT", "/songs/1")[0]?.body).toMatchObject({
      coverUrl: "https://media.example.invalid/new-artwork.png",
    }),
  );
  expect(calls("POST", "/uploads/artwork")).toHaveLength(1);
});

it("retains the old cover after upload failure and safely ignores an empty file selection", async () => {
  failures.push({
    method: "POST",
    path: "/uploads/artwork",
    status: 503,
    text: "Unavailable",
  });
  await mount();
  const dialog = await edit();
  fireEvent.change(fileInput(dialog, "image/*"), { target: { files: [] } });
  expect(calls("POST", "/uploads/artwork")).toHaveLength(0);
  fireEvent.change(fileInput(dialog, "image/*"), {
    target: { files: [new File(["image"], "cover.png")] },
  });
  expect(
    await within(dialog).findByText("Failed to upload cover file."),
  ).toBeInTheDocument();
  expect(field(dialog, "Cover URL")).toHaveValue(catalog[0].coverUrl);
});
