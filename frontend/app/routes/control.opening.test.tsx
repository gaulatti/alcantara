import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  controlServer,
  stubConsoleBrowser,
  type ControlServer,
} from "../../test/controlKit";

// gaulatti/alcantara#194 group 1: opening the live console. What the console
// loads for the active show, and what the operator sees from it.

const prefs = vi.hoisted(() => ({ workspace: "director" as string }));
const program = vi.hoisted(() => ({ id: "main" }));

vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: false }) }));
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => [program.id],
}));
vi.mock("../contexts/ConsolePreferencesContext", async (original) => {
  const actual =
    await original<typeof import("../contexts/ConsolePreferencesContext")>();
  return {
    ...actual,
    useConsolePreferences: () => ({
      profile: {
        ...actual.defaultConsoleProfile("desktop"),
        workspace: prefs.workspace,
      },
      updateProfile: vi.fn(),
    }),
  };
});

vi.mock("@gaulatti/bleecker", async (original) => {
  const kit = await import("../../test/routeKit");
  return kit.nativeSelect(
    original as () => Promise<typeof import("@gaulatti/bleecker")>,
  );
});

import Control from "./control";

let server: ControlServer;

const scene = (id: number, name: string) => ({
  id,
  name,
  layoutId: 1,
  metadata: {},
  layout: { id: 1, name: "Fixture layout", componentType: "toni-clock" },
});

const programState = (
  scenes = [scene(1, "Fictional headlines"), scene(2, "Fictional desk")],
) => ({
  id: 1,
  programId: "main",
  type: "tv",
  activeSceneId: scenes[1]?.id ?? null,
  activeScene: scenes[1] ?? null,
  stagedSceneId: scenes[0]?.id ?? null,
  stagedScene: scenes[0] ?? null,
  fadeToBlack: false,
  scenes: scenes.map((entry, index) => ({
    id: index + 1,
    sceneId: entry.id,
    position: index,
    scene: entry,
  })),
  mediaGroups: [],
});

beforeEach(() => {
  prefs.workspace = "director";
  program.id = "main";
  vi.spyOn(console, "error").mockImplementation(() => {});
  stubConsoleBrowser();
  server = controlServer({
    "GET /scenes": Response.json([
      scene(1, "Fictional headlines"),
      scene(2, "Fictional desk"),
    ]),
    "GET /songs?limit=0": Response.json({ data: [] }),
    "GET /instants": Response.json([]),
    "GET /program/main/state": () => Response.json(programState()),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("opens on the active show and lists its scenes", async () => {
  render(<Control />);
  expect(
    (await screen.findAllByText("Fictional headlines")).length,
  ).toBeGreaterThan(0);
  await waitFor(() =>
    expect(server.calls.map((call) => `${call.method} ${call.path}`)).toEqual(
      expect.arrayContaining([
        "GET /scenes",
        "GET /songs?limit=0",
        "GET /instants",
        "GET /program/main/media-groups",
        "GET /program/main/state",
      ]),
    ),
  );
});

const source = (name: string) =>
  screen.getAllByRole("button", { name: new RegExp(name) })[0];

it("marks the staged scene on the sources list, and only when the show holds it", async () => {
  render(<Control />);
  await screen.findAllByText("Fictional headlines");
  expect(source("Fictional headlines")).toHaveAttribute("aria-pressed", "true");
  expect(source("Fictional desk")).toHaveAttribute("aria-pressed", "false");
  cleanup();

  // A staged scene the show no longer lists is not staged on the console.
  server.answer("GET /program/main/state", () =>
    Response.json({ ...programState(), stagedSceneId: 99 }),
  );
  render(<Control />);
  await screen.findAllByText("Fictional headlines");
  expect(source("Fictional headlines")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

it("stays on the loading screen while the show's state cannot be read", async () => {
  server.answer(
    "GET /program/main/state",
    new Response("down", { status: 500 }),
  );
  render(<Control />);
  await waitFor(() =>
    expect(console.error).toHaveBeenCalledWith(
      "Failed to fetch program state:",
      expect.any(Error),
    ),
  );
  expect(screen.getByText("Loading main control surface…")).toBeVisible();
});

it("stays on the loading screen when the show answers with no state", async () => {
  server.answer("GET /program/main/state", Response.json(null));
  render(<Control />);
  await waitFor(() =>
    expect(server.requests("GET /program/main/state")).toHaveLength(1),
  );
  expect(screen.getByText("Loading main control surface…")).toBeVisible();
  expect(console.error).not.toHaveBeenCalledWith(
    "Failed to fetch program state:",
    expect.anything(),
  );
});

it("keeps the console open when the catalogs fail to load", async () => {
  server.answer("GET /scenes", () => Promise.reject(new TypeError("offline")));
  server.answer("GET /songs?limit=0", new Response("down", { status: 500 }));
  server.answer("GET /instants", new Response("down", { status: 500 }));
  server.answer(
    "GET /program/main/media-groups",
    new Response("down", { status: 500 }),
  );
  server.answer(
    "GET /media-labels?page=1&limit=200",
    new Response("down", { status: 500 }),
  );
  server.answer(
    "GET /media-assets?mediaType=AUDIO&capability=BACKGROUND&limit=200",
    new Response("down", { status: 500 }),
  );
  render(<Control />);
  // The show's own scenes still come from its state.
  expect(
    (await screen.findAllByText("Fictional headlines")).length,
  ).toBeGreaterThan(0);
  await waitFor(() =>
    expect(vi.mocked(console.error).mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([
        "Failed to fetch scenes:",
        "Failed to fetch songs catalog:",
        "Failed to fetch instants:",
        "Failed to fetch media groups:",
        "Failed to fetch media labels:",
        "Failed to fetch background audio:",
      ]),
    ),
  );
});

it("treats catalog answers without a list as empty", async () => {
  server.answer("GET /songs?limit=0", Response.json({ data: "none" }));
  server.answer(
    "GET /program/main/media-groups",
    Response.json({ groups: [] }),
  );
  server.answer(
    "GET /media-labels?page=1&limit=200",
    Response.json({ data: [], meta: { totalPages: 1 } }),
  );
  server.answer(
    "GET /media-assets?mediaType=AUDIO&capability=BACKGROUND&limit=200",
    Response.json({ data: "none" }),
  );
  render(<Control />);
  expect(
    (await screen.findAllByText("Fictional headlines")).length,
  ).toBeGreaterThan(0);
  await waitFor(() =>
    expect(
      server.requests(
        "GET /media-assets?mediaType=AUDIO&capability=BACKGROUND&limit=200",
      ),
    ).toHaveLength(1),
  );
  const logged = vi.mocked(console.error).mock.calls.map((call) => call[0]);
  for (const message of [
    "Failed to fetch songs catalog:",
    "Failed to fetch media groups:",
    "Failed to fetch media labels:",
    "Failed to fetch background audio:",
  ])
    expect(logged).not.toContain(message);
});

it("loads the new show when the operator switches, and drops the old show's late answers", async () => {
  let releaseOldGroups!: (response: Response) => void;
  server.answer(
    "GET /program/main/media-groups",
    () => new Promise<Response>((resolve) => (releaseOldGroups = resolve)),
  );
  server.answer("GET /program/radio/state", () =>
    Response.json({
      ...programState([scene(3, "Fictional radio desk")]),
      programId: "radio",
    }),
  );
  server.answer("GET /program/radio/media-groups", Response.json([]));
  const view = render(<Control />);
  await screen.findAllByText("Fictional headlines");

  program.id = "radio";
  view.rerender(<Control />);
  expect(
    (await screen.findAllByText("Fictional radio desk")).length,
  ).toBeGreaterThan(0);
  // The first show's media groups answer late, after the switch: ignored.
  await act(async () =>
    releaseOldGroups(new Response("down", { status: 500 })),
  );
  expect(console.error).not.toHaveBeenCalledWith(
    "Failed to fetch media groups:",
    expect.anything(),
  );
  expect(server.requests("GET /program/radio/state")).toHaveLength(1);
  expect(server.requests("GET /instants")).toHaveLength(2);
});

it("ignores the old show's media groups when they arrive after a switch", async () => {
  let releaseOldGroups!: (response: Response) => void;
  server.answer(
    "GET /program/main/media-groups",
    () => new Promise<Response>((resolve) => (releaseOldGroups = resolve)),
  );
  server.answer("GET /program/radio/state", () =>
    Response.json({ ...programState(), programId: "radio" }),
  );
  server.answer("GET /program/radio/media-groups", Response.json([]));
  const view = render(<Control />);
  await screen.findAllByText("Fictional headlines");
  program.id = "radio";
  view.rerender(<Control />);
  await waitFor(() =>
    expect(server.requests("GET /program/radio/media-groups")).toHaveLength(1),
  );
  await act(async () =>
    releaseOldGroups(Response.json([{ id: 9, name: "Old show group" }])),
  );
  expect(screen.queryByText("Old show group")).not.toBeInTheDocument();
});

it("loads the background audio scenes can play", async () => {
  server.answer(
    "GET /media-assets?mediaType=AUDIO&capability=BACKGROUND&limit=200",
    Response.json({
      data: [
        {
          id: "bg-1",
          name: "Fictional bed",
          enabled: true,
          sourceUrl: "https://media.example.test/bed.mp3",
        },
      ],
    }),
  );
  render(<Control />);
  await screen.findAllByText("Fictional headlines");
  await waitFor(() =>
    expect(
      server.requests(
        "GET /media-assets?mediaType=AUDIO&capability=BACKGROUND&limit=200",
      ),
    ).toHaveLength(1),
  );
  expect(console.error).not.toHaveBeenCalledWith(
    "Failed to fetch background audio:",
    expect.anything(),
  );
  // Which asset a scene plays is chosen in the graphics workspace (group 7).
});
