import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ProgramsAdmin, { meta } from "./programs";
import { apiUrl } from "../utils/apiBaseUrl";

// gaulatti/alcantara#187, group G5: the Shows page: the list, creating and
// editing TV, radio and simulcast shows with their scenes and stingers,
// template inspection, deleting, and each refusal.

const selection = vi.hoisted(() => ({ current: "news", set: vi.fn() }));
vi.mock("@gaulatti/bleecker", async (original) => {
  const kit = await import("../../test/routeKit");
  return kit.inlineMenus(
    original as () => Promise<typeof import("@gaulatti/bleecker")>,
  );
});
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => [selection.current, selection.set],
}));

const manifest = (capabilities: string[]) => ({
  kind: "alcantara.program-template",
  contractVersion: 1,
  id: "fixture.template",
  name: "Fixture Template",
  package: "@fixture/template",
  bundleVersion: "2.0.0",
  schemaVersion: 1,
  entrypoint: "index.html",
  entrypointUrl: "https://templates.test/fixture/index.html",
  capabilities,
  control: {
    protocol: "alcantara.program.v1",
    transport: "server-sent-events",
    snapshotPath: "state",
    eventsPath: "events",
    runtimeParameters: { programId: "programId", apiBaseUrl: "apiBaseUrl" },
    signals: [],
  },
});

const show = (programId: string, overrides: Record<string, unknown> = {}) => ({
  id: programId.length,
  programId,
  type: "tv",
  activeSceneId: null,
  scenes: [],
  mediaGroups: [],
  stingers: [],
  templateUrl: null,
  templateManifest: null,
  ...overrides,
});

type Handler = (init?: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Handler>;
let network: ReturnType<typeof vi.fn>;
let shows: Record<string, unknown>[];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

beforeEach(() => {
  selection.current = "news";
  selection.set.mockReset();
  shows = [
    show("news", {
      scenes: [{ id: 1, sceneId: 1, position: 0 }],
      stingers: [{ id: 1, stingerId: 7, position: 0 }],
      mediaGroups: [{ id: 1, mediaGroupId: 3, position: 0 }],
      activeSceneId: 1,
    }),
    show("radio one", { type: "radio" }),
    show("sim", { type: "both" }),
  ];
  routes = {
    "GET /program": () => json(shows),
    "GET /scenes": () =>
      json([
        { id: 1, name: "Wide", layout: { name: "Full frame" } },
        { id: 2, name: "Close", layout: null },
        { id: 3, name: "Anchor", layout: { name: "Desk" } },
      ]),
    "GET /stingers": () =>
      json([
        { id: 7, name: "Swoosh" },
        { id: 8, name: "Flash" },
      ]),
  };
  network = vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    const key = `${init?.method ?? "GET"} ${decodeURIComponent(parsed.pathname)}${parsed.search}`;
    const handler = routes[key];
    return handler ? handler(init) : json({}, 200);
  });
  vi.stubGlobal("fetch", network);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Where() {
  const location = useLocation();
  return <output aria-label="location">{location.pathname}</output>;
}
function open() {
  return render(
    <MemoryRouter initialEntries={["/programs"]}>
      <Routes>
        <Route path="/programs" element={<ProgramsAdmin />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}
const loaded = () =>
  waitFor(() => expect(screen.queryByText("Loading programs...")).toBeNull());
const toast = async (text: string) =>
  expect((await screen.findAllByText(text))[0]).toBeInTheDocument();
const card = (programId: string) =>
  screen
    .getByRole("heading", { name: programId, level: 3 })
    .closest("article")!;
const calls = (method: string) =>
  network.mock.calls
    .filter((call) => call[1]?.method === method)
    .map((call) => [
      decodeURIComponent(new URL(call[0]).pathname),
      call[1].body ? JSON.parse(call[1].body) : null,
    ]);
const scene = (dialog: HTMLElement, name: string) =>
  within(dialog)
    .getByText(name)
    .closest("label")!
    .querySelector("input") as HTMLInputElement;

it("names the page for the browser", () => {
  expect(meta({} as never)).toEqual([
    { title: "Shows - Alcantara" },
    {
      name: "description",
      content: "Manage television, radio, and simulcast shows",
    },
  ]);
});

it("reports shows that cannot load, and offers the first show when there are none", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  routes["GET /stingers"] = () => json({}, 500);
  open();
  await toast("Failed to load programs. Please refresh and try again.");
  cleanup();
  for (const failing of ["GET /program", "GET /scenes"]) {
    routes = {
      ...routes,
      "GET /stingers": () => json([]),
      [failing]: () => json({}, 503),
    };
    open();
    await toast("Failed to load programs. Please refresh and try again.");
    cleanup();
  }
  routes["GET /program"] = () => json([]);
  routes["GET /scenes"] = () => json([]);
  open();
  expect(await screen.findByText("No shows yet")).toBeInTheDocument();
  fireEvent.click(
    within(
      screen.getByText("No shows yet").parentElement!.parentElement!,
    ).getByRole("button", { name: "Create show" }),
  );
  expect(
    await screen.findByRole("dialog", { name: "Create show" }),
  ).toBeInTheDocument();
});

it("lists shows by id with their type, assets, renderer and selection", async () => {
  shows.push(
    show("legacy", {
      type: undefined,
      stingers: undefined,
      mediaGroups: undefined,
    }),
  );
  shows.push(
    show("templated", { templateManifest: manifest(["scene.configuration"]) }),
  );
  open();
  await loaded();
  expect(
    screen
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent),
  ).toEqual(["legacy", "news", "radio one", "sim", "templated"]);
  const news = card("news");
  expect(news).toHaveTextContent("TV");
  expect(news).toHaveTextContent("Active");
  expect(news).toHaveTextContent(
    "Scenes assigned: 1 · Media labels are available globally · Stingers assigned: 1 · Active scene: 1",
  );
  expect(news).toHaveTextContent("No template");
  expect(news).toHaveTextContent("no external template is registered");
  expect(card("radio one")).toHaveTextContent("Radio");
  expect(card("radio one")).toHaveTextContent(
    "Audio-only show · Songs, audio clips, mixer, and Radio distribution",
  );
  expect(card("radio one")).not.toHaveTextContent("Transitional");
  expect(card("sim")).toHaveTextContent("Simulcast");
  expect(card("sim")).toHaveTextContent(
    "Stingers assigned: 0 · Active scene: none",
  );
  expect(card("legacy")).toHaveTextContent("Stingers assigned: 0");
  // A show stored without a type opens as TV, with nothing selected.
  fireEvent.click(screen.getByRole("button", { name: "Edit legacy" }));
  const legacy = await screen.findByRole("dialog", { name: "Edit show" });
  expect(within(legacy).getByRole("button", { name: /TV/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(scene(legacy, "Swoosh").checked).toBe(false);
  fireEvent.click(within(legacy).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(card("templated")).toHaveTextContent("Fixture Template · 2.0.0");
  expect(
    within(card("templated")).getByRole("link", { name: /Open renderer/ }),
  ).toHaveAttribute(
    "href",
    expect.stringContaining(
      "https://templates.test/fixture/index.html?programId=templated",
    ),
  );
  fireEvent.click(within(card("sim")).getByRole("button", { name: "Select" }));
  expect(selection.set).toHaveBeenCalledWith("sim");
});

it("creates a TV show with the scenes and stingers chosen, and selects it", async () => {
  open();
  await loaded();
  fireEvent.click(screen.getAllByRole("button", { name: /Create show/ })[0]);
  const dialog = await screen.findByRole("dialog", { name: "Create show" });
  expect(within(dialog).getByRole("button", { name: /TV/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // An empty id is refused with a complete message, and typing clears it.
  const message = () => dialog.querySelector("p.text-sm.text-terracotta");
  fireEvent.click(within(dialog).getByRole("button", { name: "Create show" }));
  await waitFor(() =>
    expect(message()).toHaveTextContent(/^Program ID is required\.$/),
  );
  expect(network.mock.calls.some((call) => call[1]?.method === "POST")).toBe(
    false,
  );
  fireEvent.change(within(dialog).getByPlaceholderText("main"), {
    target: { value: " late " },
  });
  expect(message()).toBeNull();

  // Scenes: searched by name or layout.
  expect(within(dialog).getByText("No layout")).toBeInTheDocument();
  const search = within(dialog).getByRole("searchbox", {
    name: "Search program scenes",
  });
  fireEvent.change(search, { target: { value: "desk" } });
  expect(within(dialog).queryByText("Wide")).toBeNull();
  expect(within(dialog).getByText("Anchor")).toBeInTheDocument();
  fireEvent.change(search, { target: { value: "nothing" } });
  expect(
    within(dialog).getByText("No scenes match “nothing”."),
  ).toBeInTheDocument();
  fireEvent.change(search, { target: { value: "" } });
  fireEvent.click(scene(dialog, "Close"));
  fireEvent.click(scene(dialog, "Anchor"));
  fireEvent.click(scene(dialog, "Anchor"));
  fireEvent.click(scene(dialog, "Wide"));
  fireEvent.click(scene(dialog, "Swoosh"));
  fireEvent.click(scene(dialog, "Flash"));
  fireEvent.click(scene(dialog, "Swoosh"));

  let save: (response: Response) => void = () => {};
  routes["POST /program"] = () => new Promise((resolve) => (save = resolve));
  fireEvent.click(within(dialog).getByRole("button", { name: "Create show" }));
  expect(
    await within(dialog).findByRole("button", { name: "Saving..." }),
  ).toBeDisabled();
  await act(async () => save(json(show("late"))));
  await toast("Show created.");
  expect(calls("POST")).toEqual([
    ["/program", { programId: "late", type: "tv", templateUrl: null }],
    ["/program/late/scenes", { sceneId: 2 }],
    ["/program/late/scenes", { sceneId: 1 }],
    ["/program/late/stingers", { stingerId: 8 }],
  ]);
  expect(selection.set).toHaveBeenCalledWith("late");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("creates a radio show without visual assets, and a simulcast show from a template", async () => {
  open();
  await loaded();
  fireEvent.click(screen.getAllByRole("button", { name: /Create show/ })[0]);
  let dialog = await screen.findByRole("dialog", { name: "Create show" });
  fireEvent.change(within(dialog).getByPlaceholderText("main"), {
    target: { value: "night radio" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: /Radio/ }));
  expect(within(dialog).getByText(/Radio is audio-only/)).toBeInTheDocument();
  expect(within(dialog).queryByText("Template URL")).toBeNull();
  expect(within(dialog).queryByText("Program Stingers")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Create show" }));
  await toast("Show created.");
  expect(calls("POST")).toEqual([
    [
      "/program",
      { programId: "night radio", type: "radio", templateUrl: null },
    ],
  ]);

  // Simulcast with a template that takes stingers but not scenes.
  network.mockClear();
  routes["POST /program/template/inspect"] = () =>
    json({ templateManifest: manifest(["stinger.transitions"]) });
  routes["POST /program"] = () =>
    json(
      show("sim2", {
        type: "both",
        templateManifest: manifest(["stinger.transitions"]),
      }),
    );
  fireEvent.click(screen.getAllByRole("button", { name: /Create show/ })[0]);
  dialog = await screen.findByRole("dialog", { name: "Create show" });
  fireEvent.change(within(dialog).getByPlaceholderText("main"), {
    target: { value: "sim2" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: /Simulcast/ }));
  const templateField = within(dialog).getByPlaceholderText(
    /live-program-manifest\.json$/,
  );
  expect(
    within(dialog).getByRole("button", { name: "Inspect" }),
  ).toBeDisabled();
  fireEvent.change(templateField, {
    target: { value: " https://templates.test/fixture/manifest.json " },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Inspect" }));
  expect(
    await within(dialog).findByText("Fixture Template · 2.0.0"),
  ).toBeInTheDocument();
  expect(within(dialog).getByText("stinger.transitions")).toBeInTheDocument();
  expect(
    within(dialog).getByText(/Scene assignment is unavailable/),
  ).toBeInTheDocument();
  fireEvent.click(scene(dialog, "Flash"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Create show" }));
  await toast("Show created.");
  expect(calls("POST")).toEqual([
    [
      "/program/template/inspect",
      { templateUrl: "https://templates.test/fixture/manifest.json" },
    ],
    [
      "/program",
      {
        programId: "sim2",
        type: "both",
        templateUrl: "https://templates.test/fixture/manifest.json",
      },
    ],
    ["/program/sim2/stingers", { stingerId: 8 }],
  ]);
});

it("shows why a template could not be verified, and clears its preview when the URL changes", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  open();
  await loaded();
  fireEvent.click(screen.getAllByRole("button", { name: /Create show/ })[0]);
  const dialog = await screen.findByRole("dialog", { name: "Create show" });
  const templateField = within(dialog).getByPlaceholderText(
    /live-program-manifest\.json$/,
  );
  fireEvent.change(templateField, {
    target: { value: "https://templates.test/a.json" },
  });

  let inspect: (response: Response) => void = () => {};
  routes["POST /program/template/inspect"] = () =>
    new Promise((resolve) => (inspect = resolve));
  fireEvent.click(within(dialog).getByRole("button", { name: "Inspect" }));
  expect(
    await within(dialog).findByRole("button", { name: "Inspecting…" }),
  ).toBeDisabled();
  await act(async () =>
    inspect(
      json({
        templateManifest: manifest(["scene.configuration", "media.groups"]),
      }),
    ),
  );
  expect(within(dialog).getByText("media.groups")).toBeInTheDocument();
  fireEvent.change(templateField, {
    target: { value: "https://templates.test/b.json" },
  });
  expect(within(dialog).queryByText("media.groups")).toBeNull();

  for (const [index, response] of [
    new Response("Contract version 9 is not supported", { status: 422 }),
    new Response("", { status: 502 }),
  ].entries()) {
    routes["POST /program/template/inspect"] = () => response;
    fireEvent.click(within(dialog).getByRole("button", { name: "Inspect" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The template contract could not be verified.",
    );
    fireEvent.change(templateField, {
      target: { value: `https://templates.test/c${index}.json` },
    });
    expect(within(dialog).queryByRole("alert")).toBeNull();
  }
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("edits a show: renames it, syncs scenes and stingers, and keeps the selection on it", async () => {
  routes["PUT /program/news"] = () => json(show("evening news"));
  open();
  await loaded();
  fireEvent.click(screen.getByRole("button", { name: "Edit news" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit show" });
  expect(within(dialog).getByPlaceholderText("main")).toHaveValue("news");
  expect(scene(dialog, "Wide").checked).toBe(true);
  expect(scene(dialog, "Swoosh").checked).toBe(true);
  fireEvent.change(within(dialog).getByPlaceholderText("main"), {
    target: { value: "evening news" },
  });
  fireEvent.click(scene(dialog, "Wide"));
  fireEvent.click(scene(dialog, "Close"));
  fireEvent.click(scene(dialog, "Swoosh"));
  fireEvent.click(scene(dialog, "Flash"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Update show" }));
  await toast("Show updated.");
  expect(calls("PUT")).toEqual([
    [
      "/program/news",
      { nextProgramId: "evening news", type: "tv", templateUrl: null },
    ],
  ]);
  expect(
    calls("DELETE")
      .map(([path]) => path)
      .sort(),
  ).toEqual([
    "/program/evening news/scenes/1",
    "/program/evening news/stingers/7",
  ]);
  expect(calls("POST")).toEqual([
    ["/program/evening news/scenes", { sceneId: 2 }],
    ["/program/evening news/stingers", { stingerId: 8 }],
  ]);
  expect(selection.set).toHaveBeenCalledWith("evening news");
});

it("edits a show that is not selected, and one whose template takes neither scenes nor stingers", async () => {
  shows.push(
    show("templated", {
      templateUrl: "https://templates.test/t.json",
      templateManifest: manifest([]),
      stingers: [{ id: 2, stingerId: 7, position: 0 }],
    }),
  );
  routes["PUT /program/sim"] = () => json(show("sim", { type: "both" }));
  routes["PUT /program/templated"] = () =>
    json(show("templated", { templateManifest: manifest([]) }));
  routes["PUT /program/radio one"] = () =>
    json(show("radio one", { type: "radio" }));
  open();
  await loaded();
  fireEvent.click(screen.getByRole("button", { name: "Edit sim" }));
  let dialog = await screen.findByRole("dialog", { name: "Edit show" });
  expect(
    within(dialog).getByRole("button", { name: /Simulcast/ }),
  ).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(scene(dialog, "Anchor"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Update show" }));
  await toast("Show updated.");
  expect(calls("POST")).toEqual([["/program/sim/scenes", { sceneId: 3 }]]);
  expect(selection.set).not.toHaveBeenCalled();

  network.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Edit templated" }));
  dialog = await screen.findByRole("dialog", { name: "Edit show" });
  expect(
    within(dialog).getByText(/Scene assignment is unavailable/),
  ).toBeInTheDocument();
  expect(within(dialog).queryByText("Program Stingers")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Update show" }));
  await toast("Show updated.");
  expect(calls("PUT")).toEqual([
    [
      "/program/templated",
      {
        nextProgramId: "templated",
        type: "tv",
        templateUrl: "https://templates.test/t.json",
      },
    ],
  ]);
  expect(calls("POST")).toEqual([]);
  expect(calls("DELETE")).toEqual([]);

  // A radio show saves without touching scenes or stingers.
  network.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Edit radio one" }));
  dialog = await screen.findByRole("dialog", { name: "Edit show" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Update show" }));
  await toast("Show updated.");
  expect(calls("PUT")).toEqual([
    [
      "/program/radio one",
      { nextProgramId: "radio one", type: "radio", templateUrl: null },
    ],
  ]);
  expect(calls("POST")).toEqual([]);
});

it("keeps the dialog open with a message when a save or a sync is refused", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  open();
  await loaded();
  const syncFailed =
    "The show was saved, but its scenes or stingers were not updated. Edit it to try again.";
  const attempt = async (
    setup: () => void,
    edit: (dialog: HTMLElement) => void,
    message: string,
    button = "Update show",
  ) => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit news" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit show" });
    edit(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: button }));
    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  };
  const ok = () => json(show("news"));
  await attempt(
    () =>
      (routes["PUT /program/news"] = () =>
        new Response("Duplicate id", { status: 409 })),
    () => {},
    "A show with this ID already exists. Choose another ID.",
  );
  await attempt(
    () =>
      (routes["PUT /program/news"] = () =>
        json(
          { statusCode: 409, message: "That ID belongs to a deleted show's settings. Choose another ID." },
          409,
        )),
    () => {},
    "That ID belongs to a deleted show's settings. Choose another ID.",
  );
  await attempt(
    () =>
      (routes["PUT /program/news"] = () => new Response("", { status: 500 })),
    () => {},
    "Failed to save show (HTTP 500). Nothing was saved.",
  );
  await attempt(
    () => {
      routes["PUT /program/news"] = ok;
      routes["DELETE /program/news/scenes/1"] = () => json({}, 500);
    },
    (dialog) => fireEvent.click(scene(dialog, "Wide")),
    syncFailed,
  );
  await attempt(
    () => (routes["POST /program/news/scenes"] = () => json({}, 500)),
    (dialog) => fireEvent.click(scene(dialog, "Close")),
    syncFailed,
  );
  await attempt(
    () => (routes["DELETE /program/news/stingers/7"] = () => json({}, 500)),
    (dialog) => fireEvent.click(scene(dialog, "Swoosh")),
    syncFailed,
  );
  await attempt(
    () => (routes["POST /program/news/stingers"] = () => json({}, 500)),
    (dialog) => fireEvent.click(scene(dialog, "Flash")),
    syncFailed,
  );
  await toast("Failed to save show.");
});

// Each refused create in its own test: the long refusal test above passed alone in 1.5 s but crossed vitest's 5 s
// limit under a loaded full run.
const refusedCreates: [string, () => Response, string][] = [
  ["a duplicate ID", () => new Response("Taken", { status: 409 }), "A show with this ID already exists. Choose another ID."],
  ["a server error", () => new Response("", { status: 500 }), "Failed to save show (HTTP 500). Nothing was saved."],
  [
    "a refusal with a reason",
    () => json({ statusCode: 400, message: "Radio programs do not support visual templates" }, 400),
    "Failed to save show: Radio programs do not support visual templates",
  ],
  [
    "a refusal with several reasons",
    () => json({ statusCode: 400, message: ["id is too long", "id is blank"] }, 400),
    "Failed to save show: id is too long; id is blank",
  ],
  ["a plain-text refusal", () => new Response("Plain refusal", { status: 400 }), "Failed to save show: Plain refusal"],
  ["an empty refusal", () => new Response("", { status: 400 }), "Failed to save show (HTTP 400). Nothing was saved."],
  [
    "a refusal with no message",
    () => json({ statusCode: 400, error: "Bad Request" }, 400),
    "Failed to save show (HTTP 400). Nothing was saved.",
  ],
  [
    "an unreachable server",
    () => {
      throw new TypeError("Failed to fetch");
    },
    "Failed to save show: the server could not be reached. Nothing was saved.",
  ],
];

it.each(refusedCreates)("says why creating a show was refused: %s", async (_case, answer, message) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  open();
  await loaded();
  routes["POST /program"] = answer;
  fireEvent.click(screen.getAllByRole("button", { name: /Create show/ })[0]);
  const dialog = await screen.findByRole("dialog", { name: "Create show" });
  fireEvent.change(within(dialog).getByPlaceholderText("main"), {
    target: { value: "dup" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create show" }));
  expect(await within(dialog).findByText(message)).toBeInTheDocument();
});

it("opens the scene and stinger managers, and says when there are none", async () => {
  routes["GET /scenes"] = () => json([]);
  routes["GET /stingers"] = () => json([]);
  open();
  await loaded();
  fireEvent.click(screen.getAllByRole("button", { name: /Create show/ })[0]);
  let dialog = await screen.findByRole("dialog", { name: "Create show" });
  expect(
    within(dialog).getByText("No scenes available. Create scenes first."),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByText("No stingers available. Create stingers first."),
  ).toBeInTheDocument();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Manage Scenes" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("status", { name: "location" })).toHaveTextContent(
      "/scenes",
    ),
  );
  cleanup();
  open();
  await loaded();
  fireEvent.click(screen.getAllByRole("button", { name: /Create show/ })[0]);
  dialog = await screen.findByRole("dialog", { name: "Create show" });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Manage Stingers" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("status", { name: "location" })).toHaveTextContent(
      "/stingers",
    ),
  );
});

// Delete is confirmed in a named dialog before the request is sent (gaulatti/alcantara#349).
const confirmDelete = async () =>
  fireEvent.click(
    within(await screen.findByRole("dialog", { name: "Confirm delete" })).getByRole("button", { name: "Delete show" }),
  );

it("dismisses the delete confirmation with Escape and deletes nothing", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  open();
  await loaded();
  fireEvent.click(within(card("news")).getByRole("button", { name: "Actions for news" }));
  fireEvent.click(within(card("news")).getByText("Delete show"));
  const dialog = await screen.findByRole("dialog", { name: "Confirm delete" });
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirm delete" })).toBeNull());
  expect(calls("DELETE")).toEqual([]);
  expect(card("news")).toBeInTheDocument();
});

it("deletes a show after confirmation and moves the selection off it", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  open();
  await loaded();
  fireEvent.click(within(card("news")).getByRole("button", { name: "Actions for news" }));
  fireEvent.click(within(card("news")).getByText("Delete show"));
  const dialog = await screen.findByRole("dialog", { name: "Confirm delete" });
  expect(dialog).toHaveTextContent('Delete show “news”?');
  expect(calls("DELETE")).toEqual([]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirm delete" })).toBeNull());
  expect(calls("DELETE")).toEqual([]);

  // The selected show: the first remaining one is selected.
  routes["DELETE /program/news"] = () => {
    shows = shows.filter((entry) => entry.programId !== "news");
    return json({});
  };
  fireEvent.click(within(card("news")).getByRole("button", { name: "Actions for news" }));
  fireEvent.click(within(card("news")).getByText("Delete show"));
  await confirmDelete();
  await toast("Show deleted.");
  expect(selection.set).toHaveBeenLastCalledWith("radio one");

  // Another show: the selection stays.
  selection.set.mockClear();
  fireEvent.click(within(card("sim")).getByRole("button", { name: "Actions for sim" }));
  fireEvent.click(within(card("sim")).getByText("Delete show"));
  await confirmDelete();
  await waitFor(() =>
    expect(calls("DELETE")).toContainEqual(["/program/sim", null]),
  );
  expect(selection.set).not.toHaveBeenCalled();

  // The last show: the selection falls back to main.
  cleanup();
  selection.current = "radio one";
  selection.set.mockClear();
  shows = [show("radio one", { type: "radio" })];
  routes["DELETE /program/radio one"] = () => {
    shows = [];
    return json({});
  };
  open();
  await loaded();
  fireEvent.click(within(card("radio one")).getByRole("button", { name: "Actions for radio one" }));
  fireEvent.click(within(card("radio one")).getByText("Delete show"));
  await confirmDelete();
  await waitFor(() => expect(selection.set).toHaveBeenCalledWith("main"));

  shows = [show("radio one", { type: "radio" })];
  for (const response of [
    new Response("In use", { status: 409 }),
    new Response("", { status: 500 }),
  ]) {
    routes["DELETE /program/radio one"] = () => response;
    cleanup();
    open();
    await loaded();
    fireEvent.click(within(card("radio one")).getByRole("button", { name: "Actions for radio one" }));
  fireEvent.click(within(card("radio one")).getByText("Delete show"));
    await confirmDelete();
    await toast("Failed to delete show.");
  }
});
