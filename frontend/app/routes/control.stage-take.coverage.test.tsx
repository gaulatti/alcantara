import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  controlServer,
  stubConsoleBrowser,
  type ControlServer,
} from "../../test/controlKit";

// gaulatti/alcantara#404 (control.tsx stronger pass): a Preview or a take whose request fails without an Error says
// so in plain words, and a second take pressed while one is on its way sends nothing more.

vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: true }) }));
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

// Lets an answer already sent reach the console before checking its absence.
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

const scene = (
  id: number,
  name: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  name,
  layoutId: 1,
  metadata: {},
  layout: { id: 1, name: "Fixture layout", componentType: "toni-clock" },
  ...extra,
});
const headlines = scene(1, "Fictional headlines");
const bed = scene(2, "Fictional bed scene", {
  metadata: JSON.stringify({
    player: { show: true },
    sceneInstant: { assetId: "a1", instantId: null },
  }),
  layout: { id: 2, name: "Player layout", componentType: "player" },
});

function open(staged: typeof headlines | null = null) {
  const scenes = [headlines, bed];
  server = controlServer({
    "GET /scenes": Response.json(scenes),
    "GET /instants": Response.json([]),
    "GET /songs?limit=0": Response.json({ data: [] }),
    "GET /program/main/state": Response.json({
      id: 1,
      programId: "main",
      type: "tv",
      version: 5,
      activeSceneId: null,
      stagedSceneId: staged?.id ?? null,
      stagedScene: staged,
      fadeToBlack: false,
      scenes: scenes.map((entry, index) => ({
        id: index + 1,
        sceneId: entry.id,
        position: index,
        scene: entry,
      })),
      mediaGroups: [],
    }),
    "GET /program/main/media-groups": Response.json([]),
    "GET /media-assets?mediaType=AUDIO&capability=BACKGROUND&limit=200":
      Response.json({
        data: [{ id: "a1", name: "Fictional rain", enabled: true }],
      }),
  });
  render(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  stubConsoleBrowser();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("says the Preview could not be prepared when the request fails without a reason", async () => {
  open();
  server.answer("POST /program/main/stage", () => {
    throw "offline";
  });
  fireEvent.click(
    (await screen.findAllByRole("button", { name: /Fictional headlines/ }))[0],
  );
  expect(await screen.findByText("Could not prepare Preview.")).toBeVisible();
});

it("says the scene was not taken when the take fails without a reason", async () => {
  open(headlines);
  server.answer("POST /program/main/activate", () => {
    throw "offline";
  });
  await screen.findAllByRole("button", { name: /Fictional headlines/ });
  fireEvent.keyDown(window, { code: "Space", key: " " });
  expect(
    await screen.findByText("The scene was not taken to Program."),
  ).toBeVisible();
});

it("sends one take while a take is on its way, however often it is pressed", async () => {
  open(headlines);
  let answer: (response: Response) => void = () => {};
  server.answer(
    "POST /program/main/activate",
    () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  );
  await screen.findAllByRole("button", { name: /Fictional headlines/ });
  fireEvent.keyDown(window, { code: "Space", key: " " });
  await waitFor(() =>
    expect(server.requests("POST /program/main/activate")).toHaveLength(1),
  );
  fireEvent.keyDown(window, { code: "Space", key: " " });
  fireEvent.keyDown(window, { code: "Space", key: " " });
  await settle();
  expect(server.requests("POST /program/main/activate")).toHaveLength(1);
  await act(async () => {
    answer(
      Response.json({
        id: 1,
        programId: "main",
        type: "tv",
        activeSceneId: 1,
        stagedSceneId: null,
        scenes: [],
      }),
    );
  });
});

it("takes nothing when the take is pressed with no scene in Preview", async () => {
  open();
  await screen.findAllByRole("button", { name: /Fictional headlines/ });
  fireEvent.keyDown(window, { code: "Space", key: " " });
  await settle();
  expect(server.requests("POST /program/main/activate")).toEqual([]);
});
