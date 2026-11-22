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
import SongsCatalog, { meta } from "./songs";
import { apiUrl } from "../utils/apiBaseUrl";

// gaulatti/alcantara#187, group G4: the song catalog page, through the
// catalog, instants and upload clients and the songs API it calls.
// Replacing a song's audio from the edit dialog is covered with its fix
// (songs.replace.test.tsx).

const fetchSongsPage = vi.hoisted(() => vi.fn());
const fetchInstants = vi.hoisted(() => vi.fn());
const uploadFileToMediaBucket = vi.hoisted(() => vi.fn());
vi.mock("../services/songs", () => ({ fetchSongsPage }));
vi.mock("../services/instants", () => ({ fetchInstants }));
vi.mock("../services/uploads", () => ({ uploadFileToMediaBucket }));
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => ["radio one"],
}));

type Song = Record<string, unknown>;
const song = (id: number, overrides: Song = {}): Song => ({
  id,
  artist: `Artist ${id}`,
  title: `Title ${id}`,
  audioUrl: `https://media.test/${id}.mp3`,
  coverUrl: null,
  durationMs: 185_000,
  earoneSongId: null,
  earoneRank: null,
  earoneSpins: null,
  enabled: true,
  intro: null,
  ...overrides,
});
const pageOf = (data: Song[], meta: Record<string, number> = {}) => ({
  data,
  meta: {
    total: data.length,
    page: 1,
    limit: 50,
    totalPages: 1,
    catalogTotal: data.length,
    catalogEnabled: data.length,
    catalogTotalDurationMs: 0,
    catalogKnownDurationCount: 0,
    ...meta,
  },
});

/** jsdom cannot play or read audio: each element plays or fails as the test says. */
class TestAudio {
  static created: TestAudio[] = [];
  static play: () => Promise<void> = () => Promise.resolve();
  static duration = Number.NaN;
  static loads = true;
  onloadedmetadata: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onended: (() => void) | null = null;
  preload = "";
  duration = TestAudio.duration;
  constructor(public src = "") {
    TestAudio.created.push(this);
  }
  play() {
    return TestAudio.play();
  }
  load() {
    queueMicrotask(() =>
      TestAudio.loads ? this.onloadedmetadata?.() : this.onerror?.(),
    );
  }
}

let network: ReturnType<typeof vi.fn>;

beforeEach(() => {
  TestAudio.created = [];
  TestAudio.play = () => Promise.resolve();
  TestAudio.duration = Number.NaN;
  TestAudio.loads = true;
  vi.stubGlobal("Audio", TestAudio);
  URL.createObjectURL = vi.fn(() => "blob:file");
  URL.revokeObjectURL = vi.fn();
  network = vi.fn(
    async () => new Response(JSON.stringify({}), { status: 200 }),
  );
  vi.stubGlobal("fetch", network);
  fetchSongsPage.mockResolvedValue(pageOf([song(1)]));
  fetchInstants.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchSongsPage.mockReset();
  fetchInstants.mockReset();
  uploadFileToMediaBucket.mockReset();
});

const toast = async (text: string) =>
  expect((await screen.findAllByText(text))[0]).toBeInTheDocument();
const loaded = () =>
  waitFor(() => expect(screen.queryByText("Loading songs...")).toBeNull());
const lastQuery = () => fetchSongsPage.mock.lastCall![0];

it("names the page for the browser", () => {
  expect(meta({} as never)).toEqual([
    { title: "Songs - TV Broadcast" },
    {
      name: "description",
      content: "Manage global songs catalog for ModoItaliano sequences",
    },
  ]);
});

it("summarises the catalog and lists each song with its cover, number, duration and intro", async () => {
  fetchSongsPage.mockResolvedValue(
    pageOf(
      [
        song(1, {
          coverUrl: "https://media.test/1.jpg",
          intro: { instantId: 5, instant: { name: "Hello segue" } },
        }),
        song(2, { artist: "", title: "", durationMs: null, enabled: false }),
        song(3, { artist: "  Solo  ", title: " ", durationMs: 400 }),
      ],
      {
        total: 3,
        catalogTotal: 10,
        catalogEnabled: 8,
        catalogTotalDurationMs: 3_725_000,
        catalogKnownDurationCount: 9,
      },
    ),
  );
  render(<SongsCatalog />);
  expect(screen.getByText("Loading songs...")).toBeInTheDocument();
  await loaded();
  expect(fetchSongsPage).toHaveBeenCalledWith({
    search: undefined,
    sortBy: "artist",
    sortOrder: "asc",
    page: 1,
    programId: "radio one",
  });
  expect(fetchInstants).toHaveBeenCalledWith("radio one");
  expect(screen.getByText("10")).toBeInTheDocument();
  expect(screen.getByText("8 enabled")).toBeInTheDocument();
  expect(screen.getByText("62:05")).toBeInTheDocument();
  expect(screen.getByText("9 with known runtime")).toBeInTheDocument();
  expect(
    screen.getByText("matching current filters").previousSibling,
  ).toHaveTextContent("3");

  // The phone list.
  const cards = Array.from(document.querySelectorAll("article"));
  expect(cards[0]).toHaveTextContent("#1 · 3:05 · Intro assigned");
  expect(cards[0].querySelector("img")).toHaveAttribute(
    "src",
    "https://media.test/1.jpg",
  );
  expect(cards[1]).toHaveTextContent("Untitled");
  expect(cards[1]).toHaveTextContent("Unknown artist");
  expect(cards[1]).toHaveTextContent("#2 · Unknown · No intro");
  expect(cards[1]).toHaveClass("opacity-60");
  expect(cards[2]).toHaveTextContent("#3 · 0:01");

  // The wide table.
  expect(screen.getByText("Song intro: Hello segue")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Preview Artist 1 - Title 1" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Edit Untitled song" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Delete Solo" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "—" })).toBeInTheDocument();
});

it("gives the wide table's action buttons their own column, so the duration is not covered", async () => {
  fetchSongsPage.mockResolvedValue(pageOf([song(1), song(2, { durationMs: null })]));
  render(<SongsCatalog />);
  await loaded();
  const columns =
    "grid-cols-[2.5rem_2rem_minmax(0,1fr)_minmax(0,1fr)_5rem_8.5rem]";
  const preview = screen.getByRole("button", { name: "Preview Artist 1 - Title 1" });
  const row = preview.closest(".group") as HTMLElement;
  const header = row.parentElement!.previousElementSibling as HTMLElement;
  // The header and every row share one grid, and the last column (3 icon buttons of 2.5rem
  // and two 0.25rem gaps, 8rem) is wider than the 6rem that used to overlap the duration.
  expect(header).toHaveClass(columns);
  expect(row).toHaveClass(columns);
  expect(row.children).toHaveLength(6);
  expect(row.children[4]).toHaveTextContent("3:05");
  expect(row.children[5]).toContainElement(preview);
  expect(row.children[5].querySelectorAll("button")).toHaveLength(3);
  expect(
    screen.getByRole("button", { name: "Preview Artist 2 - Title 2" }).closest(".group")!
      .children[4],
  ).toHaveTextContent("Unknown");
});

it("offers the first song when the catalog is empty", async () => {
  fetchSongsPage.mockResolvedValue(pageOf([]));
  render(<SongsCatalog />);
  expect(await screen.findByText("No songs yet")).toBeInTheDocument();
  expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
  const empty = screen.getByText("No songs yet").parentElement!.parentElement!;
  fireEvent.click(within(empty).getByRole("button", { name: "Add song" }));
  expect(
    await screen.findByRole("dialog", { name: "Add song" }),
  ).toBeInTheDocument();
});

it("searches after a pause, hides disabled songs, sorts and pages, and clears filters that match nothing", async () => {
  fetchSongsPage.mockResolvedValue(
    pageOf([song(1)], { total: 1, catalogTotal: 120, totalPages: 3 }),
  );
  render(<SongsCatalog />);
  await loaded();

  fireEvent.change(
    screen.getByPlaceholderText("Search by artist, title, or EarOne ID"),
    { target: { value: "amore" } },
  );
  await waitFor(() =>
    expect(lastQuery()).toMatchObject({ search: "amore", page: 1 }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Show disabled songs" }),
  );
  await waitFor(() => expect(lastQuery()).toMatchObject({ enabled: true }));

  fireEvent.click(screen.getByRole("button", { name: /^Title/ }));
  await waitFor(() =>
    expect(lastQuery()).toMatchObject({ sortBy: "title", sortOrder: "asc" }),
  );
  fireEvent.click(screen.getByRole("button", { name: /^Title/ }));
  await waitFor(() =>
    expect(lastQuery()).toMatchObject({ sortBy: "title", sortOrder: "desc" }),
  );
  fireEvent.click(screen.getByRole("button", { name: /^Title/ }));
  await waitFor(() =>
    expect(lastQuery()).toMatchObject({ sortBy: "title", sortOrder: "asc" }),
  );
  fireEvent.click(screen.getByRole("button", { name: /^Duration/ }));
  await waitFor(() =>
    expect(lastQuery()).toMatchObject({
      sortBy: "durationMs",
      sortOrder: "asc",
    }),
  );

  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Pagination" })).getByRole(
      "button",
      { name: "2" },
    ),
  );
  await waitFor(() => expect(lastQuery()).toMatchObject({ page: 2 }));
  expect(document.querySelector("article")).toHaveTextContent("#51");

  // An artist name filters by that artist.
  fireEvent.click(screen.getByRole("button", { name: "Artist 1" }));
  await waitFor(() =>
    expect(lastQuery()).toMatchObject({ search: "Artist 1", page: 1 }),
  );

  fetchSongsPage.mockResolvedValue(pageOf([], { total: 0, catalogTotal: 120 }));
  fireEvent.change(
    screen.getByPlaceholderText("Search by artist, title, or EarOne ID"),
    { target: { value: "zzz" } },
  );
  expect(
    await screen.findByText("No songs match this search"),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Clear Filters" }));
  await waitFor(() => expect(lastQuery()).toMatchObject({ search: undefined }));
  expect(lastQuery()).not.toHaveProperty("enabled");
  expect(
    screen.getByPlaceholderText("Search by artist, title, or EarOne ID"),
  ).toHaveValue("");
});

it("reports a catalog or a set of intro clips that cannot load", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  fetchSongsPage.mockRejectedValue(new Error("offline"));
  fetchInstants.mockRejectedValue(new Error("offline"));
  render(<SongsCatalog />);
  await toast("Failed to load songs catalog.");
  await toast("Failed to load audio clips for song intros.");
  expect(errors).toHaveBeenCalledWith(
    "Failed to load songs:",
    expect.any(Error),
  );
});

it("previews a song, and reports one the browser will not play", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(<SongsCatalog />);
  await loaded();
  fireEvent.click(
    screen.getByRole("button", { name: "Preview Artist 1 - Title 1" }),
  );
  await waitFor(() =>
    expect(TestAudio.created.at(-1)?.src).toBe("https://media.test/1.mp3"),
  );
  expect(TestAudio.created.at(-1)?.preload).toBe("auto");
  TestAudio.play = () => Promise.reject(new Error("NotAllowedError"));
  fireEvent.click(
    within(document.querySelector("article")!).getByRole("button", {
      name: /Preview/,
    }),
  );
  await toast("Failed to play song preview.");
});

it("deletes a song after confirmation, and reports a refused delete", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<SongsCatalog />);
  await loaded();
  fireEvent.click(
    screen.getByRole("button", { name: "Delete Artist 1 - Title 1" }),
  );
  expect(confirm).toHaveBeenCalledWith('Delete song "Artist 1 - Title 1"?');
  expect(network).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  fireEvent.click(
    within(document.querySelector("article")!).getByRole("button", {
      name: /Delete/,
    }),
  );
  await toast("Song deleted.");
  expect(network).toHaveBeenCalledWith(apiUrl("/songs/1"), {
    method: "DELETE",
  });
  network.mockResolvedValueOnce(new Response("gone", { status: 404 }));
  fireEvent.click(
    screen.getByRole("button", { name: "Delete Artist 1 - Title 1" }),
  );
  await toast("Failed to delete song.");
});

async function openEdit(overrides: Song = {}) {
  fetchSongsPage.mockResolvedValue(pageOf([song(1, overrides)]));
  render(<SongsCatalog />);
  await loaded();
  fireEvent.click(screen.getByRole("button", { name: /^Edit / }));
  return screen.findByRole("dialog", { name: "Edit song" });
}
const field = (dialog: HTMLElement, label: string) =>
  within(dialog)
    .getByText(label, { selector: "label" })
    .parentElement!.querySelector("input") as HTMLInputElement;
const putBody = () => JSON.parse(String(network.mock.lastCall![1].body));

it("edits a song: every field, the intro and the cover, and saves it", async () => {
  fetchInstants.mockResolvedValue([
    {
      id: 5,
      name: "Hello segue",
      audioUrl: "https://media.test/hello.mp3",
      enabled: true,
      volume: 1,
      position: 1,
    },
  ]);
  const dialog = await openEdit({
    coverUrl: "https://media.test/c.jpg",
    earoneSongId: "e1",
    earoneRank: "4",
    earoneSpins: "20",
    intro: { instantId: 5, instant: { name: "Hello segue" } },
  });
  expect(field(dialog, "Artist")).toHaveValue("Artist 1");
  expect(field(dialog, "Cover URL")).toHaveValue("https://media.test/c.jpg");
  expect(field(dialog, "Duration (ms)")).toHaveValue(185000);
  expect(field(dialog, "EarOne Rank")).toHaveValue("4");
  expect(within(dialog).getByText("Replace song file")).toBeInTheDocument();
  expect(
    within(dialog).getByRole("combobox", { name: "Assigned song intro" }),
  ).toHaveValue("5");

  // Preview the intro; it clears when the clip ends or will not play.
  fireEvent.click(
    within(dialog).getByRole("button", { name: /Preview intro/ }),
  );
  expect(
    await within(dialog).findByRole("button", { name: /Previewing…/ }),
  ).toBeDisabled();
  act(() => TestAudio.created.at(-1)!.onended?.());
  expect(
    await within(dialog).findByRole("button", { name: /Preview intro/ }),
  ).toBeEnabled();
  TestAudio.play = () => Promise.reject(new Error("NotAllowedError"));
  fireEvent.click(
    within(dialog).getByRole("button", { name: /Preview intro/ }),
  );
  expect(
    await within(dialog).findByRole("button", { name: /Preview intro/ }),
  ).toBeEnabled();

  // A new cover.
  vi.spyOn(console, "error").mockImplementation(() => {});
  const cover = dialog.querySelector(
    'input[type="file"][accept="image/*"]',
  ) as HTMLInputElement;
  fireEvent.change(cover, { target: { files: [] } });
  expect(uploadFileToMediaBucket).not.toHaveBeenCalled();
  let finish: (value: unknown) => void = () => {};
  uploadFileToMediaBucket.mockImplementationOnce(
    () => new Promise((resolve) => (finish = resolve)),
  );
  const image = new File(["img"], "cover.png", { type: "image/png" });
  fireEvent.change(cover, { target: { files: [image] } });
  expect(
    await within(dialog).findByText("Uploading cover…"),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByRole("button", { name: "Update Song" }),
  ).toBeDisabled();
  await act(async () => finish({ url: "https://media.test/new.png" }));
  expect(uploadFileToMediaBucket).toHaveBeenCalledWith("artwork", image);
  expect(field(dialog, "Cover URL")).toHaveValue("https://media.test/new.png");
  await toast("Cover uploaded.");
  uploadFileToMediaBucket.mockRejectedValueOnce(new Error("too big"));
  fireEvent.change(cover, { target: { files: [image] } });
  await toast("Failed to upload cover file.");
  expect(
    within(dialog).getByText("Failed to upload cover file.", { selector: "p" }),
  ).toBeInTheDocument();

  // Every field.
  fireEvent.change(field(dialog, "Artist"), {
    target: { value: "  New artist " },
  });
  fireEvent.change(field(dialog, "Title"), {
    target: { value: " New title " },
  });
  fireEvent.change(field(dialog, "Audio URL"), {
    target: { value: " https://media.test/x.mp3 " },
  });
  fireEvent.change(field(dialog, "Cover URL"), { target: { value: "  " } });
  fireEvent.change(field(dialog, "Duration (ms)"), {
    target: { value: "200400.6" },
  });
  fireEvent.change(field(dialog, "EarOne Song ID"), {
    target: { value: " e9 " },
  });
  fireEvent.change(field(dialog, "EarOne Rank"), { target: { value: " " } });
  fireEvent.change(field(dialog, "EarOne Spins"), { target: { value: "7" } });
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Enabled" }));
  fireEvent.change(
    within(dialog).getByRole("combobox", { name: "Assigned song intro" }),
    { target: { value: "" } },
  );
  expect(
    within(dialog).getByText(
      "Saving removes the current song intro assignment.",
    ),
  ).toBeInTheDocument();

  let save: (value: Response) => void = () => {};
  network.mockImplementationOnce(
    () => new Promise((resolve) => (save = resolve)),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Update Song" }));
  expect(
    await within(dialog).findByRole("button", { name: "Saving..." }),
  ).toBeDisabled();
  await act(async () => save(new Response("{}")));
  expect(network).toHaveBeenCalledWith(
    apiUrl("/songs/1"),
    expect.objectContaining({ method: "PUT" }),
  );
  expect(
    JSON.parse(
      String(
        network.mock.calls.find((call) => call[1]?.method === "PUT")![1].body,
      ),
    ),
  ).toEqual({
    artist: "New artist",
    title: "New title",
    audioUrl: "https://media.test/x.mp3",
    coverUrl: null,
    durationMs: 200401,
    earoneSongId: "e9",
    earoneRank: null,
    earoneSpins: "7",
    enabled: false,
    programId: "radio one",
    introInstantId: null,
  });
  await toast("Song updated.");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("checks the song before saving and shows why a save was refused", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const dialog = await openEdit({ durationMs: null });
  expect(field(dialog, "Duration (ms)")).toHaveValue(null);
  const save = () =>
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Update Song" }),
    );

  fireEvent.change(field(dialog, "Audio URL"), { target: { value: " " } });
  save();
  expect(
    await within(dialog).findByText(
      "Audio URL is required. Upload a song file first.",
    ),
  ).toBeInTheDocument();
  fireEvent.change(field(dialog, "Audio URL"), {
    target: { value: "https://media.test/1.mp3" },
  });
  fireEvent.change(field(dialog, "Artist"), { target: { value: "" } });
  fireEvent.change(field(dialog, "Title"), { target: { value: " " } });
  save();
  expect(
    await within(dialog).findByText("Artist or title is required."),
  ).toBeInTheDocument();
  fireEvent.change(field(dialog, "Title"), {
    target: { value: "Only a title" },
  });
  fireEvent.change(field(dialog, "Duration (ms)"), { target: { value: "-5" } });
  save();
  expect(
    await within(dialog).findByText(
      "Duration must be a positive number in milliseconds.",
    ),
  ).toBeInTheDocument();
  fireEvent.change(field(dialog, "Duration (ms)"), { target: { value: "" } });
  expect(network).not.toHaveBeenCalled();

  // Each way the API explains a refusal.
  const refusals: [Response, string][] = [
    [
      new Response(JSON.stringify({ message: "Title already exists." }), {
        status: 409,
      }),
      "Title already exists.",
    ],
    [
      new Response(
        JSON.stringify({ message: ["audioUrl must be a URL", " ", 3] }),
        { status: 400 },
      ),
      "audioUrl must be a URL",
    ],
    [
      new Response(JSON.stringify({ message: [" "] }), { status: 400 }),
      '{"message":[" "]}',
    ],
    [
      new Response(JSON.stringify({ message: "  " }), { status: 400 }),
      '{"message":"  "}',
    ],
    [new Response("Bad gateway", { status: 502 }), "Bad gateway"],
    [new Response("", { status: 500 }), "HTTP 500"],
  ];
  for (const [response, message] of refusals) {
    network.mockResolvedValueOnce(response);
    save();
    expect(
      await within(dialog).findByText(message, {
        selector: "p",
        normalizer: (text) => text,
      }),
    ).toBeInTheDocument();
  }
  expect(putBody()).toMatchObject({
    artist: "",
    title: "Only a title",
    durationMs: null,
    coverUrl: null,
    introInstantId: null,
  });

  network.mockRejectedValueOnce("offline");
  save();
  expect(
    await within(dialog).findByText("Failed to save song.", { selector: "p" }),
  ).toBeInTheDocument();

  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("adds songs from several files, reading what each file says about itself", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(<SongsCatalog />);
  await loaded();
  fireEvent.click(screen.getAllByRole("button", { name: /Add song/ })[0]);
  const dialog = await screen.findByRole("dialog", { name: "Add song" });
  const picker = dialog.querySelector(
    'input[type="file"][accept="audio/*"]',
  ) as HTMLInputElement;
  fireEvent.change(picker, { target: { files: [] } });
  expect(uploadFileToMediaBucket).not.toHaveBeenCalled();
  expect(
    within(dialog).getByRole("button", { name: "Cancel" }),
  ).toBeInTheDocument();

  const files = [
    "tagged.mp3",
    "bare.mp3",
    "refused.mp3",
    "broken.mp3",
    "thrown.mp3",
  ].map((name) => new File(["audio"], name, { type: "audio/mpeg" }));
  let firstUpload: (value: unknown) => void = () => {};
  uploadFileToMediaBucket
    .mockImplementationOnce(
      () => new Promise((resolve) => (firstUpload = resolve)),
    )
    .mockResolvedValueOnce({ url: "https://media.test/bare.mp3" })
    .mockResolvedValueOnce({
      url: "https://media.test/refused.mp3",
      metadata: { artist: 3, title: 4, coverUrl: 5, durationMs: -1 },
    })
    .mockRejectedValueOnce(new Error("Upload too large"))
    .mockRejectedValueOnce("not an error");
  network
    .mockResolvedValueOnce(new Response("{}"))
    .mockResolvedValueOnce(new Response("{}"))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Duplicate song." }), {
        status: 409,
      }),
    );
  TestAudio.duration = 61.4;
  fireEvent.change(picker, { target: { files } });
  expect(await within(dialog).findByText("⟳")).toBeInTheDocument();
  expect(within(dialog).getAllByText("·")).toHaveLength(4);
  expect(picker).toBeDisabled();
  await act(async () =>
    firstUpload({
      url: "https://media.test/tagged.mp3",
      metadata: {
        artist: " Tagged ",
        title: " Song ",
        coverUrl: " https://media.test/t.jpg ",
        durationMs: 200000.7,
      },
    }),
  );
  await waitFor(() =>
    expect(within(dialog).getAllByText(/^[✓✗]$/)).toHaveLength(5),
  );
  expect(within(dialog).getAllByText("✓")).toHaveLength(2);
  expect(within(dialog).getByText("Duplicate song.")).toBeInTheDocument();
  expect(within(dialog).getByText("Upload too large")).toBeInTheDocument();
  expect(within(dialog).getByText("Upload failed")).toBeInTheDocument();
  const posts = network.mock.calls
    .filter((call) => call[1]?.method === "POST")
    .map((call) => JSON.parse(String(call[1].body)));
  expect(posts[0]).toEqual({
    artist: "Tagged",
    title: "Song",
    audioUrl: "https://media.test/tagged.mp3",
    coverUrl: "https://media.test/t.jpg",
    durationMs: 200001,
    enabled: true,
  });
  // No tags: the file name is the artist and the file's own length is used.
  expect(posts[1]).toEqual({
    artist: "bare",
    title: "",
    audioUrl: "https://media.test/bare.mp3",
    coverUrl: null,
    durationMs: 61400,
    enabled: true,
  });
  expect(posts[2]).toMatchObject({
    artist: "refused",
    title: "",
    coverUrl: null,
  });
  expect(
    within(dialog).getByRole("button", { name: "Done" }),
  ).toBeInTheDocument();
  await waitFor(() => expect(fetchSongsPage).toHaveBeenCalledTimes(2));
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("adds nothing to the catalog when every file fails, and reads no length from a file it cannot open", async () => {
  render(<SongsCatalog />);
  await loaded();
  fireEvent.click(screen.getAllByRole("button", { name: /Add song/ })[0]);
  const dialog = await screen.findByRole("dialog", { name: "Add song" });
  const picker = dialog.querySelector(
    'input[type="file"][accept="audio/*"]',
  ) as HTMLInputElement;
  uploadFileToMediaBucket.mockResolvedValue({
    url: "https://media.test/a.mp3",
  });
  network.mockResolvedValue(new Response("", { status: 500 }));
  TestAudio.loads = false;
  fireEvent.change(picker, { target: { files: [new File(["a"], "a.mp3")] } });
  expect(await within(dialog).findByText("HTTP 500")).toBeInTheDocument();
  expect(JSON.parse(String(network.mock.lastCall![1].body))).toMatchObject({
    durationMs: null,
  });
  TestAudio.loads = true;
  TestAudio.duration = 0;
  fireEvent.change(picker, { target: { files: [new File(["b"], "b.mp3")] } });
  await waitFor(() => expect(network).toHaveBeenCalledTimes(2));
  expect(JSON.parse(String(network.mock.lastCall![1].body))).toMatchObject({
    durationMs: null,
  });
  expect(fetchSongsPage).toHaveBeenCalledTimes(1);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:file");
});

it("keeps the assigned intro when a song is saved, and filters by a missing artist as everything", async () => {
  fetchInstants.mockResolvedValue([
    {
      id: 5,
      name: "Hello segue",
      audioUrl: "https://media.test/hello.mp3",
      enabled: true,
      volume: 1,
      position: 1,
    },
  ]);
  const dialog = await openEdit({
    artist: "",
    intro: { instantId: 5, instant: { name: "Hello segue" } },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Update Song" }));
  await toast("Song updated.");
  expect(putBody()).toMatchObject({ introInstantId: 5, artist: "" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.change(
    screen.getByPlaceholderText("Search by artist, title, or EarOne ID"),
    { target: { value: "x" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "—" }));
  expect(
    screen.getByPlaceholderText("Search by artist, title, or EarOne ID"),
  ).toHaveValue("");
});
