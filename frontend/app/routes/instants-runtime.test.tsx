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
import InstantsAdmin from "./instants";

// The catalogue, upload service, validation and rendered controls remain real.
// All HTTP/session/browser boundaries point to fictional local test responses.
vi.mock("../services/session", () => ({
  getAppSession: async () => ({ token: "fixture-session" }),
}));
vi.mock("../utils/apiBaseUrl", () => ({
  getApiBaseUrl: () => "https://clips-fixture.invalid",
  apiUrl: (path: string) =>
    path.startsWith("https:") ? path : `https://clips-fixture.invalid${path}`,
}));
type Clip = {
  id: number;
  name: string;
  audioUrl: string;
  volume: number;
  enabled: boolean;
  position: number;
};
let clips: Clip[];
let programId: string;
let requests: { method: string; path: string; body: any; headers: Headers }[];
let failures: Record<string, { status: number; body: string }>;
let networkFailures: Record<string, unknown>;
let unexpected: string[];
let uploadUrl: string;
let hold: { path: string; promise: Promise<void>; release: () => void } | null;
function pause(path: string) {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  hold = { path, promise, release };
  return release;
}
async function transport(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(String(input));
  const path = url.pathname + url.search;
  const method = init?.method ?? "GET";
  const body =
    init?.body instanceof FormData
      ? init.body
      : init?.body
        ? JSON.parse(String(init.body))
        : null;
  requests.push({ method, path, body, headers: new Headers(init?.headers) });
  if (hold?.path === url.pathname) await hold.promise;
  if (Object.hasOwn(networkFailures, `${method} ${url.pathname}`))
    throw networkFailures[`${method} ${url.pathname}`];
  const failure = failures[`${method} ${url.pathname}`];
  if (failure) return new Response(failure.body, { status: failure.status });
  if (url.pathname === "/operator-preferences/desktop")
    return Response.json({
      version: 1,
      profile: {
        workspace: "director",
        dockWidth: 320,
        touchMode: false,
        shortcutsEnabled: true,
        selectedProgramId: programId,
        transitions: { [programId]: "cut" },
      },
    });
  if (url.pathname === "/uploads/instant") {
    const file = (body as FormData).get("file") as File;
    return Response.json({
      key: "fixtures/clips/upload.mp3",
      url: uploadUrl,
      bucket: "fictional-fixture-bucket",
      contentType: file.type,
      sizeBytes: file.size,
    });
  }
  if (url.pathname === "/instants") {
    if (method === "GET") return Response.json(clips);
    if (method === "POST") {
      clips.push({ id: 14, position: clips.length, ...body });
      return Response.json(clips.at(-1));
    }
  }
  const entry = url.pathname.match(/^\/instants\/(\d+)$/);
  if (entry) {
    const id = Number(entry[1]);
    if (method === "PUT") {
      clips = clips.map((clip) =>
        clip.id === id ? { ...clip, ...body } : clip,
      );
      return Response.json(clips.find((clip) => clip.id === id));
    }
    if (method === "DELETE") {
      clips = clips.filter((clip) => clip.id !== id);
      return Response.json({ deletedId: id });
    }
  }
  if (
    method === "POST" &&
    (/^\/instants\/\d+\/play$/.test(url.pathname) ||
      url.pathname === "/instants/stop-all")
  )
    return Response.json({});
  unexpected.push(`${method} ${path}`);
  throw new Error(`Unexpected fixture request: ${method} ${path}`);
}
const dialogDescriptors = new Map(
  ["showModal", "close"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
  ]),
);
beforeEach(() => {
  clips = [
    {
      id: 11,
      name: "Bravo sting",
      audioUrl: "https://media-fixture.invalid/bravo.mp3",
      volume: 0.7,
      enabled: true,
      position: 2,
    },
    {
      id: 12,
      name: "Alpha sting",
      audioUrl: "https://media-fixture.invalid/alpha.mp3",
      volume: 0.2,
      enabled: false,
      position: 0,
    },
    {
      id: 13,
      name: "Zulu sting",
      audioUrl: "https://media-fixture.invalid/zulu.mp3",
      volume: 1,
      enabled: true,
      position: 1,
    },
  ];
  uploadUrl = "https://media-fixture.invalid/upload.mp3";
  programId = "main";
  requests = [];
  failures = {};
  networkFailures = {};
  unexpected = [];
  hold = null;
  localStorage.clear();
  vi.stubGlobal("innerWidth", 1600);
  vi.stubGlobal("fetch", vi.fn(transport));
  vi.spyOn(window, "confirm").mockReturnValue(true);
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
      this.dispatchEvent(new Event("close"));
    },
  });
});
afterEach(() => {
  hold?.release();
  // Dismiss the real library's notifications so they cannot become evidence
  // for a later case after its container is remounted.
  const alerts = screen.queryAllByRole("button", { name: "Close alert" });
  if (alerts.length) {
    vi.useFakeTimers();
    alerts.forEach((alert) => fireEvent.click(alert));
    act(() => {
      vi.advanceTimersByTime(220);
    });
  }
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [name, descriptor] of dialogDescriptors) {
    if (descriptor)
      Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
  expect(unexpected).toEqual([]);
});
async function mount() {
  const store = legacy_createStore(reducers, {
    auth: {
      loaded: true,
      currentUser: { id: "operator-a", email: "operator@example.invalid" },
    },
    preferences: { selectedLanguage: "en" },
  } as any);
  const view = render(
    <Provider store={store}>
      <MemoryRouter>
        <ConsolePreferencesProvider>
          <InstantsAdmin />
        </ConsolePreferencesProvider>
      </MemoryRouter>
    </Provider>,
  );
  await waitFor(() =>
    expect(
      screen.queryByText("Loading audio clips..."),
    ).not.toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(
      localStorage.getItem("alcantara.console.acknowledged.operator-a.desktop"),
    ).not.toBeNull(),
  );
  return view;
}
const writes = (path: string) =>
  requests.filter(
    (request) => request.path === path && request.method !== "GET",
  );
const rowNames = () =>
  within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[1].textContent);
async function openCreate() {
  fireEvent.click(
    screen.getAllByRole("button", { name: "Create audio clip" })[0],
  );
  return screen.findByRole("dialog", { name: "Create audio clip" });
}
async function openEdit(name = "Bravo sting") {
  fireEvent.click(screen.getByRole("button", { name: `Edit ${name}` }));
  return screen.findByRole("dialog", { name: "Edit audio clip" });
}
function chooseFile(dialog: HTMLElement, name = "news.mp3") {
  const file = new File(["fictional audio bytes"], name, {
    type: "audio/mpeg",
  });
  fireEvent.change(dialog.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });
  return file;
}
it("loads and displays real table/mobile catalogue entries in accepted position order", async () => {
  await mount();
  expect(rowNames()).toEqual(["Alpha sting", "Zulu sting", "Bravo sting"]);
  expect(screen.getAllByRole("article")).toHaveLength(3);
  expect(
    within(screen.getByRole("table")).getByText("Disabled"),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole("table")).getByText("0.70"),
  ).toBeInTheDocument();
});
it.each([
  [
    "Name",
    ["Alpha sting", "Bravo sting", "Zulu sting"],
    ["Zulu sting", "Bravo sting", "Alpha sting"],
  ],
  [
    "Volume",
    ["Alpha sting", "Bravo sting", "Zulu sting"],
    ["Zulu sting", "Bravo sting", "Alpha sting"],
  ],
  [
    "Status",
    ["Alpha sting", "Bravo sting", "Zulu sting"],
    ["Bravo sting", "Zulu sting", "Alpha sting"],
  ],
])(
  "sorts %s ascending and descending without rewriting the catalogue",
  async (field, ascending, descending) => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: field as string }));
    expect(rowNames()).toEqual(ascending);
    fireEvent.click(screen.getByRole("button", { name: field as string }));
    expect(rowNames()).toEqual(descending);
    expect(requests.filter((request) => request.method !== "GET")).toHaveLength(
      0,
    );
  },
);
it("shows a useful empty catalogue with creation available", async () => {
  clips = [];
  await mount();
  expect(screen.getByText("No audio clips yet")).toBeInTheDocument();
  expect(
    screen.getAllByRole("button", { name: "Create audio clip" }),
  ).toHaveLength(2);
});
it("plays a clip from the desktop table for the selected program only", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Play Bravo sting" }));
  await screen.findByText("Audio clip triggered.");
  expect(writes("/instants/11/play?programId=main")).toHaveLength(1);
});
it("plays the corresponding clip from the actual mobile card", async () => {
  await mount();
  const article = screen
    .getAllByRole("article")
    .find((article) => within(article).queryByText("Bravo sting"))!;
  fireEvent.click(within(article).getByRole("button", { name: "Play" }));
  await screen.findByText("Audio clip triggered.");
  expect(writes("/instants/11/play?programId=main")).toHaveLength(1);
});
it("scopes and encodes play and Stop-all commands to the selected program", async () => {
  programId = "studio / west";
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Play Bravo sting" }));
  await screen.findByText("Audio clip triggered.");
  fireEvent.click(screen.getByRole("button", { name: "Stop all" }));
  await screen.findByText("Stop command sent.");
  expect(
    writes("/instants/11/play?programId=studio%20%2F%20west"),
  ).toHaveLength(1);
  expect(
    writes("/instants/stop-all?programId=studio%20%2F%20west"),
  ).toHaveLength(1);
});
it("requires a trimmed name before uploading or saving", async () => {
  await mount();
  const dialog = await openCreate();
  fireEvent.change(within(dialog).getByPlaceholderText("Hit FX"), {
    target: { value: "  " },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Create audio clip" }),
  );
  expect(within(dialog).getByText("Name is required.")).toBeInTheDocument();
  expect(writes("/uploads/instant")).toHaveLength(0);
  expect(writes("/instants")).toHaveLength(0);
});
it.each(["-0.1", "1.1"])(
  "rejects out-of-range volume %s before any upload",
  async (volume) => {
    await mount();
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByPlaceholderText("Hit FX"), {
      target: { value: "New sting" },
    });
    fireEvent.change(within(dialog).getByRole("spinbutton"), {
      target: { value: volume },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create audio clip" }),
    );
    expect(
      within(dialog).getByText("Volume must be between 0 and 1."),
    ).toBeInTheDocument();
    expect(writes("/uploads/instant")).toHaveLength(0);
  },
);
it("requires an audio file and restores the save button after validation", async () => {
  await mount();
  const dialog = await openCreate();
  fireEvent.change(within(dialog).getByPlaceholderText("Hit FX"), {
    target: { value: "New sting" },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Create audio clip" }),
  );
  await within(dialog).findByText("Audio file is required.");
  expect(
    within(dialog).getByRole("button", { name: "Create audio clip" }),
  ).toBeEnabled();
  expect(writes("/instants")).toHaveLength(0);
});
it("uploads actual multipart input then creates the clip with the acknowledged URL", async () => {
  await mount();
  const dialog = await openCreate();
  fireEvent.change(within(dialog).getByPlaceholderText("Hit FX"), {
    target: { value: "  New sting  " },
  });
  const file = chooseFile(dialog);
  fireEvent.change(within(dialog).getByRole("spinbutton"), {
    target: { value: "0.35" },
  });
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Enabled" }));
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Create audio clip" }),
  );
  await screen.findByText("Audio clip created.");
  const upload = writes("/uploads/instant")[0];
  expect(upload.body).toBeInstanceOf(FormData);
  expect((upload.body as FormData).get("file")).toBe(file);
  expect(upload.headers.get("Authorization")).toBe("Bearer fixture-session");
  expect(writes("/instants")[0].body).toEqual({
    name: "New sting",
    audioUrl: "https://media-fixture.invalid/upload.mp3",
    volume: 0.35,
    enabled: false,
  });
  expect(rowNames()).toContain("New sting");
});
it("edits metadata using existing audio without uploading another object", async () => {
  await mount();
  const dialog = await openEdit();
  expect(
    within(dialog).getByText("Using existing uploaded audio."),
  ).toBeInTheDocument();
  fireEvent.change(within(dialog).getByPlaceholderText("Hit FX"), {
    target: { value: "Bravo revised" },
  });
  fireEvent.change(within(dialog).getByRole("spinbutton"), {
    target: { value: "0.4" },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Update audio clip" }),
  );
  await screen.findByText("Audio clip updated.");
  expect(writes("/uploads/instant")).toHaveLength(0);
  expect(writes("/instants/11")[0].body).toEqual({
    name: "Bravo revised",
    audioUrl: "https://media-fixture.invalid/bravo.mp3",
    volume: 0.4,
    enabled: true,
  });
});
it("replaces an edited clip's audio only after the real upload succeeds", async () => {
  await mount();
  const dialog = await openEdit();
  chooseFile(dialog, "replacement.mp3");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Update audio clip" }),
  );
  await screen.findByText("Audio clip updated.");
  expect(writes("/uploads/instant")).toHaveLength(1);
  expect(writes("/instants/11")[0].body.audioUrl).toBe(
    "https://media-fixture.invalid/upload.mp3",
  );
});
it("requires confirmation before deleting and refreshes the accepted inventory", async () => {
  await mount();
  vi.mocked(window.confirm).mockReturnValueOnce(false);
  fireEvent.click(screen.getByRole("button", { name: "Delete Bravo sting" }));
  expect(writes("/instants/11")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Delete Bravo sting" }));
  await screen.findByText("Audio clip deleted.");
  expect(rowNames()).not.toContain("Bravo sting");
});
it("cancels create and clears its unsaved name and selected file", async () => {
  await mount();
  let dialog = await openCreate();
  chooseFile(dialog);
  fireEvent.change(within(dialog).getByPlaceholderText("Hit FX"), {
    target: { value: "Unsaved sting" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  dialog = await openCreate();
  expect(within(dialog).getByPlaceholderText("Hit FX")).toHaveValue("");
  expect(
    within(dialog).getByText("No audio selected yet."),
  ).toBeInTheDocument();
  expect(writes("/uploads/instant")).toHaveLength(0);
});
it.each([
  ["publisher offline", "publisher offline"],
  ["", "HTTP 503"],
])(
  "reports a rejected play without claiming success (%s)",
  async (body, detail) => {
    await mount();
    failures["POST /instants/11/play"] = { status: 503, body };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: "Play Bravo sting" }));
    await screen.findByText("Failed to trigger audio clip.");
    expect(screen.queryByText("Audio clip triggered.")).not.toBeInTheDocument();
    expect(errors).toHaveBeenCalledWith(
      "Failed to trigger audio clip:",
      expect.objectContaining({ message: detail }),
    );
  },
);
it.each([
  ["engine offline", "engine offline"],
  ["", "HTTP 503"],
])("reports a rejected Stop-all command (%s)", async (body, detail) => {
  await mount();
  failures["POST /instants/stop-all"] = { status: 503, body };
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  fireEvent.click(screen.getByRole("button", { name: "Stop all" }));
  await screen.findByText("Failed to stop audio clips.");
  expect(errors).toHaveBeenCalledWith(
    "Failed to stop audio clips:",
    expect.objectContaining({ message: detail }),
  );
  expect(screen.queryByText("Stop command sent.")).not.toBeInTheDocument();
});
it.each([
  ["conflicting reference", "conflicting reference"],
  ["", "HTTP 503"],
])(
  "retains the accepted clip when deletion is rejected (%s)",
  async (body, detail) => {
    await mount();
    failures["DELETE /instants/11"] = { status: 503, body };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: "Delete Bravo sting" }));
    await screen.findByText("Failed to delete audio clip.");
    expect(rowNames()).toContain("Bravo sting");
    expect(errors).toHaveBeenCalledWith(
      "Failed to delete instant:",
      expect.objectContaining({ message: detail }),
    );
  },
);
it.each([
  [
    JSON.stringify({ message: "Name rejected by backend" }),
    "Name rejected by backend",
  ],
  [
    JSON.stringify({ message: ["Invalid name", "", "File too large"] }),
    "Invalid name, File too large",
  ],
  ["Service unavailable", "Service unavailable"],
  ["", "HTTP 503"],
  [JSON.stringify({ message: "   " }), JSON.stringify({ message: "   " })],
  [
    JSON.stringify({ message: ["", "   "] }),
    JSON.stringify({ message: ["", "   "] }),
  ],
  [
    JSON.stringify({ detail: "No usable message field" }),
    JSON.stringify({ detail: "No usable message field" }),
  ],
])(
  "preserves a backend validation error in the editing form (%s)",
  async (body, message) => {
    await mount();
    failures["PUT /instants/11"] = { status: 503, body };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const dialog = await openEdit();
    fireEvent.change(within(dialog).getByPlaceholderText("Hit FX"), {
      target: { value: "Rejected edit" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Update audio clip" }),
    );
    await within(dialog).findByText(message, { normalizer: (value) => value });
    expect(clips.find((clip) => clip.id === 11)?.name).toBe("Bravo sting");
    expect(
      within(dialog).getByRole("button", { name: "Update audio clip" }),
    ).toBeEnabled();
    expect(errors).toHaveBeenCalledWith(
      "Failed to save instant:",
      expect.objectContaining({ message }),
    );
  },
);
it("provides a safe fallback for a non-Error transport rejection", async () => {
  await mount();
  networkFailures["PUT /instants/11"] = "opaque fixture rejection";
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const dialog = await openEdit();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Update audio clip" }),
  );
  await within(dialog).findByText("Failed to save audio clip.");
  expect(errors).toHaveBeenCalledWith(
    "Failed to save instant:",
    "opaque fixture rejection",
  );
});
it.each([
  ["Upload service rejected file", "Upload service rejected file"],
  ["", "Upload failed (503)"],
])(
  "does not create a clip after a rejected real upload (%s)",
  async (body, message) => {
    await mount();
    failures["POST /uploads/instant"] = { status: 503, body };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByPlaceholderText("Hit FX"), {
      target: { value: "New sting" },
    });
    chooseFile(dialog);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create audio clip" }),
    );
    await within(dialog).findByText(message, { normalizer: (value) => value });
    expect(writes("/instants")).toHaveLength(0);
    expect(
      within(dialog).getByRole("button", { name: "Create audio clip" }),
    ).toBeEnabled();
  },
);
it("shows upload progress and blocks duplicate save or cancellation while bytes are pending", async () => {
  await mount();
  const release = pause("/uploads/instant");
  const dialog = await openCreate();
  fireEvent.change(within(dialog).getByPlaceholderText("Hit FX"), {
    target: { value: "New sting" },
  });
  chooseFile(dialog);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Create audio clip" }),
  );
  expect(
    await within(dialog).findByRole("button", { name: "Uploading..." }),
  ).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(dialog.querySelector('input[type="file"]')).toBeDisabled();
  expect(writes("/instants")).toHaveLength(0);
  release();
  await screen.findByText("Audio clip created.");
  expect(writes("/uploads/instant")).toHaveLength(1);
});
it("shows save progress while updating an existing uploaded clip", async () => {
  await mount();
  const release = pause("/instants/11");
  const dialog = await openEdit();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Update audio clip" }),
  );
  expect(
    await within(dialog).findByRole("button", { name: "Saving..." }),
  ).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  release();
  await screen.findByText("Audio clip updated.");
  expect(writes("/uploads/instant")).toHaveLength(0);
});
it("clears validation errors when the operator corrects name, volume or audio selection", async () => {
  await mount();
  const dialog = await openCreate();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Create audio clip" }),
  );
  expect(within(dialog).getByText("Name is required.")).toBeInTheDocument();
  fireEvent.change(within(dialog).getByPlaceholderText("Hit FX"), {
    target: { value: "New sting" },
  });
  expect(
    within(dialog).queryByText("Name is required."),
  ).not.toBeInTheDocument();
  fireEvent.change(within(dialog).getByRole("spinbutton"), {
    target: { value: "2" },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Create audio clip" }),
  );
  expect(
    within(dialog).getByText("Volume must be between 0 and 1."),
  ).toBeInTheDocument();
  fireEvent.change(within(dialog).getByRole("spinbutton"), {
    target: { value: "0.5" },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Create audio clip" }),
  );
  await within(dialog).findByText("Audio file is required.");
  chooseFile(dialog);
  expect(
    within(dialog).queryByText("Audio file is required."),
  ).not.toBeInTheDocument();
});
it("supports cancelling a file chooser selection without retaining a stale upload", async () => {
  await mount();
  const dialog = await openCreate();
  chooseFile(dialog);
  expect(within(dialog).getByText("Selected: news.mp3")).toBeInTheDocument();
  fireEvent.change(dialog.querySelector('input[type="file"]')!, {
    target: { files: [] },
  });
  expect(
    within(dialog).getByText("No audio selected yet."),
  ).toBeInTheDocument();
  expect(writes("/uploads/instant")).toHaveLength(0);
});
it("edits and deletes through the actual mobile card controls", async () => {
  await mount();
  let article = screen
    .getAllByRole("article")
    .find((article) => within(article).queryByText("Bravo sting"))!;
  fireEvent.click(within(article).getByRole("button", { name: "Edit" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit audio clip" });
  fireEvent.change(within(dialog).getByPlaceholderText("Hit FX"), {
    target: { value: "Bravo mobile" },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Update audio clip" }),
  );
  await screen.findByText("Audio clip updated.");
  article = screen
    .getAllByRole("article")
    .find((article) => within(article).queryByText("Bravo mobile"))!;
  fireEvent.click(within(article).getByRole("button", { name: "Delete" }));
  await screen.findByText("Audio clip deleted.");
  expect(clips.some((clip) => clip.id === 11)).toBe(false);
});
it("closes a create form through its native dialog close control without upload", async () => {
  await mount();
  const dialog = await openCreate();
  chooseFile(dialog);
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(writes("/uploads/instant")).toHaveLength(0);
  expect(writes("/instants")).toHaveLength(0);
});
it("reports an initial catalogue failure without inventing clips", async () => {
  failures["GET /instants"] = { status: 503, body: "Fixture unavailable" };
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await mount();
  expect(screen.getByText("No audio clips yet")).toBeInTheDocument();
  expect(screen.getByText("Failed to load audio clips.")).toBeInTheDocument();
  expect(errors).toHaveBeenCalledWith(
    "Failed to load instants:",
    expect.any(Error),
  );
});
it("does not publish a clip when upload acknowledgement omits its usable media URL", async () => {
  uploadUrl = "";
  await mount();
  const dialog = await openCreate();
  fireEvent.change(within(dialog).getByPlaceholderText("Hit FX"), {
    target: { value: "New sting" },
  });
  chooseFile(dialog);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Create audio clip" }),
  );
  await within(dialog).findByText("Audio file is required.");
  expect(writes("/uploads/instant")).toHaveLength(1);
  expect(writes("/instants")).toHaveLength(0);
  expect(
    within(dialog).getByRole("button", { name: "Create audio clip" }),
  ).toBeEnabled();
});
it("shows loading until the initial catalogue response is settled", async () => {
  const release = pause("/instants");
  const pending = mount();
  await screen.findByText("Loading audio clips...");
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  release();
  await pending;
  expect(rowNames()).toHaveLength(3);
});
it("keeps an acknowledged server write distinct from a failed inventory refresh", async () => {
  await mount();
  const dialog = await openEdit();
  failures["GET /instants"] = { status: 503, body: "Fixture unavailable" };
  vi.spyOn(console, "error").mockImplementation(() => {});
  fireEvent.change(within(dialog).getByPlaceholderText("Hit FX"), {
    target: { value: "Server accepted rename" },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Update audio clip" }),
  );
  await within(dialog).findByText("Failed to fetch instants: 503");
  expect(clips.find((clip) => clip.id === 11)?.name).toBe(
    "Server accepted rename",
  );
  expect(rowNames()).toContain("Bravo sting");
  expect(screen.queryByText("Audio clip updated.")).not.toBeInTheDocument();
});
it("does not announce deletion success when the post-delete inventory cannot be verified", async () => {
  await mount();
  failures["GET /instants"] = { status: 503, body: "Fixture unavailable" };
  vi.spyOn(console, "error").mockImplementation(() => {});
  fireEvent.click(screen.getByRole("button", { name: "Delete Bravo sting" }));
  await screen.findByText("Failed to delete audio clip.");
  expect(clips.some((clip) => clip.id === 11)).toBe(false);
  expect(rowNames()).toContain("Bravo sting");
  expect(screen.queryByText("Audio clip deleted.")).not.toBeInTheDocument();
});
it("retains existing audio if a replacement file chooser selection is cancelled", async () => {
  await mount();
  const dialog = await openEdit();
  chooseFile(dialog, "replacement.mp3");
  fireEvent.change(dialog.querySelector('input[type="file"]')!, {
    target: { files: [] },
  });
  expect(
    within(dialog).getByText("Using existing uploaded audio."),
  ).toBeInTheDocument();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Update audio clip" }),
  );
  await screen.findByText("Audio clip updated.");
  expect(writes("/uploads/instant")).toHaveLength(0);
  expect(writes("/instants/11")[0].body.audioUrl).toBe(
    "https://media-fixture.invalid/bravo.mp3",
  );
});
it.each(["0", "1"])(
  "accepts the real volume boundary %s without changing it",
  async (volume) => {
    await mount();
    const dialog = await openEdit();
    fireEvent.change(within(dialog).getByRole("spinbutton"), {
      target: { value: volume },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Update audio clip" }),
    );
    await screen.findByText("Audio clip updated.");
    expect(writes("/instants/11")[0].body.volume).toBe(Number(volume));
  },
);
it("starts a new clip from defaults after cancelling an edit to a disabled clip", async () => {
  await mount();
  const editing = await openEdit("Alpha sting");
  expect(
    within(editing).getByRole("checkbox", { name: "Enabled" }),
  ).not.toBeChecked();
  fireEvent.click(within(editing).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  const creating = await openCreate();
  expect(within(creating).getByPlaceholderText("Hit FX")).toHaveValue("");
  expect(within(creating).getByRole("spinbutton")).toHaveValue(1);
  expect(
    within(creating).getByRole("checkbox", { name: "Enabled" }),
  ).toBeChecked();
  expect(
    within(creating).getByText("No audio selected yet."),
  ).toBeInTheDocument();
  expect(writes("/uploads/instant")).toHaveLength(0);
});
it("keeps usable messages from an untrusted mixed backend validation array", async () => {
  await mount();
  failures["PUT /instants/11"] = {
    status: 422,
    body: JSON.stringify({
      message: [null, 7, "", "Valid backend explanation"],
    }),
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  const dialog = await openEdit();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Update audio clip" }),
  );
  await within(dialog).findByText("Valid backend explanation");
  expect(clips.find((clip) => clip.id === 11)?.name).toBe("Bravo sting");
  expect(
    within(dialog).getByRole("button", { name: "Update audio clip" }),
  ).toBeEnabled();
});
