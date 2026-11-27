import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#194, last pass: a Preview the program refuses to prepare,
// a stale prepare answer, and scene background audio the program refuses to
// take.

vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: true }) }));
vi.mock("../utils/globalProgram", () => ({ useGlobalProgramId: () => ["main"] }));
vi.mock("../contexts/ConsolePreferencesContext", async (original) => {
  const actual = await original<typeof import("../contexts/ConsolePreferencesContext")>();
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

const scene = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  layoutId: 1,
  metadata: {},
  layout: { id: 1, name: "Fixture layout", componentType: "toni-clock" },
  ...extra,
});
const headlines = scene(1, "Fictional headlines");
const bed = scene(2, "Fictional bed scene", {
  metadata: JSON.stringify({ player: { show: true }, sceneInstant: { assetId: "a1", instantId: null } }),
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
      scenes: scenes.map((entry, index) => ({ id: index + 1, sceneId: entry.id, position: index, scene: entry })),
      mediaGroups: [],
    }),
    "GET /program/main/media-groups": Response.json([]),
    "GET /media-assets?mediaType=AUDIO&capability=BACKGROUND&limit=200": Response.json({
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

it("says why the program could not prepare a Preview, and ignores a stale prepare answer", async () => {
  open();
  server.answer("POST /program/main/stage", new Response("down", { status: 503 }));
  fireEvent.click((await screen.findAllByRole("button", { name: /Fictional headlines/ }))[0]);
  expect(await screen.findByText("Could not prepare Preview: HTTP 503")).toBeVisible();

  // An answer older than the program the console shows prepares nothing.
  server.answer(
    "POST /program/main/stage",
    Response.json({ version: 1, stagedSceneId: 1, stagedScene: headlines }),
  );
  fireEvent.click(screen.getAllByRole("button", { name: /Fictional headlines/ })[0]);
  await waitFor(() => expect(server.requests("POST /program/main/stage")).toHaveLength(2));
  await settle();
  expect(screen.getByRole("region", { name: "PREVIEW monitor" })).not.toHaveTextContent("Fictional headlines");
});

it("shows nothing playing when the program refuses to take the scene's background audio", async () => {
  open(bed);
  // The refusal carries a playing body: only the status says it failed.
  server.answer(
    "POST /program/main/scene-instant/take",
    Response.json({ sceneId: 2, isPlaying: true, instant: { name: "Fictional rain" } }, { status: 500 }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "TAKE BG" }));
  await waitFor(() => expect(server.requests("POST /program/main/scene-instant/take")).toHaveLength(1));
  await settle();
  expect(screen.queryByText(/^Playing:/)).toBeNull();
  expect(screen.getByRole("button", { name: "STOP BG" })).toBeDisabled();
});
