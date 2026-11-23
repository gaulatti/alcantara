import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  controlServer,
  stubConsoleBrowser,
  type ControlServer,
} from "../../test/controlKit";

// TAKE (here the Space shortcut) adds a staged scene the show does not list yet. When the show refuses
// that, the operator sees why, and nothing is taken to Program.

vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: false }) }));
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => ["main"],
}));
vi.mock("../contexts/ConsolePreferencesContext", async (original) => {
  const actual =
    await original<typeof import("../contexts/ConsolePreferencesContext")>();
  return {
    ...actual,
    useConsolePreferences: () => ({
      profile: actual.defaultConsoleProfile("desktop"),
      updateProfile: vi.fn(),
    }),
  };
});

import Control from "./control";

let server: ControlServer;
let stateReads: number;

const scene = (id: number, name: string) => ({
  id,
  name,
  layoutId: 1,
  metadata: {},
  layout: { id: 1, name: "Fixture layout", componentType: "toni-clock" },
});
const headlines = scene(1, "Fictional headlines");
const guestDesk = scene(3, "Fictional guest desk");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  stubConsoleBrowser();
  stateReads = 0;
  server = controlServer({
    "GET /scenes": Response.json([headlines, guestDesk]),
    // The first read opens the console; later reads fail, so the staged
    // scene the show does not list stays staged until TAKE.
    "GET /program/main/state": () => {
      stateReads += 1;
      return stateReads === 1
        ? Response.json({
            id: 1,
            programId: "main",
            type: "tv",
            activeSceneId: null,
            fadeToBlack: false,
            scenes: [{ id: 1, sceneId: 1, position: 0, scene: headlines }],
            mediaGroups: [],
          })
        : new Response("down", { status: 503 });
    },
    "POST /program/main/stage": Response.json({
      stagedSceneId: 3,
      stagedScene: guestDesk,
    }),
    "POST /program/main/activate": Response.json({}),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function takeUnlistedScene() {
  render(<Control />);
  fireEvent.click(
    (await screen.findAllByRole("button", { name: /Fictional headlines/ }))[0],
  );
  await waitFor(() =>
    expect(server.requests("POST /program/main/stage")).toHaveLength(1),
  );
  const readsBeforeTake = stateReads;
  // The TAKE button only follows scenes the show lists; the Space shortcut
  // takes whatever is staged, so it reaches the add.
  fireEvent.keyDown(window, { code: "Space", key: " " });
  await waitFor(() =>
    expect(server.requests("POST /program/main/scenes")).toEqual([
      { sceneId: 3 },
    ]),
  );
  return readsBeforeTake;
}

it.each([
  [
    "with its reason",
    () =>
      Response.json(
        { statusCode: 409, message: "Scene 3 belongs to another show." },
        { status: 409 },
      ),
    "The scene could not be added to this show: Scene 3 belongs to another show.",
  ],
  [
    "without a readable reason",
    () => new Response("", { status: 500 }),
    "The scene could not be added to this show.",
  ],
])(
  "shows a refused add %s, takes nothing, and still reloads the show",
  async (_case, answer, message) => {
    server.answer("POST /program/main/scenes", answer);
    const readsBeforeTake = await takeUnlistedScene();
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(server.requests("POST /program/main/activate")).toEqual([]);
    expect(stateReads).toBeGreaterThan(readsBeforeTake);
  },
);

it("shows an add that never reached the studio, and takes nothing", async () => {
  server.answer("POST /program/main/scenes", () =>
    Promise.reject(new TypeError("Failed to fetch")),
  );
  await takeUnlistedScene();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The scene could not be added to this show. Check the connection and try again.",
  );
  expect(server.requests("POST /program/main/activate")).toEqual([]);
});

it("takes the scene once the show accepts it", async () => {
  server.answer("POST /program/main/scenes", Response.json({}));
  await takeUnlistedScene();
  await waitFor(() =>
    expect(server.requests("POST /program/main/activate")).toHaveLength(1),
  );
  expect(server.requests("POST /program/main/activate")[0]).toMatchObject({
    sceneId: 3,
  });
});
