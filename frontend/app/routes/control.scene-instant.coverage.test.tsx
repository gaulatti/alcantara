import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#404 (group A, control.tsx): the scene's background audio. A scene that sets a
// background asset takes it on air (TAKE BG); a failed stop (STOP BG) is reported to the console and the
// playback state is left alone; a scene that names a legacy instant takes that instant's asset.

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

function sceneWith(sceneInstant: Record<string, unknown>) {
  return {
    id: 1,
    name: "Fictional player scene",
    layoutId: 1,
    metadata: JSON.stringify({ header: { show: false }, sceneInstant }),
    layout: { id: 1, name: "Fixture layout", componentType: "header" },
  };
}

function open(scene: ReturnType<typeof sceneWith>, instants: unknown[] = []) {
  server = controlServer({
    "GET /scenes": Response.json([scene]),
    "GET /instants": Response.json(instants),
    "GET /songs?limit=0": Response.json([]),
    "GET /program/main/state": Response.json({
      id: 1,
      programId: "main",
      type: "tv",
      activeSceneId: null,
      stagedSceneId: 1,
      stagedScene: scene,
      fadeToBlack: false,
      scenes: [{ id: 1, sceneId: 1, position: 0, scene }],
      mediaGroups: [],
    }),
    "GET /program/main/media-groups": Response.json([]),
    "GET /media-assets?mediaType=AUDIO&capability=BACKGROUND&limit=200": Response.json({
      data: [
        { id: "a1", name: "Fictional rain", enabled: true },
        { id: "legacy-asset", name: "Fictional wind", enabled: true },
      ],
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

it("takes the scene's background audio on air, and reports a failed stop without changing what is playing", async () => {
  open(sceneWith({ assetId: "a1" }));
  fireEvent.click(await screen.findByRole("tab", { name: "Background audio" }));
  server.answer(
    "POST /program/main/scene-instant/take",
    Response.json({ sceneId: 1, mediaAssetId: "a1", isPlaying: true, instant: null }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "TAKE BG" }));
  const stop = await screen.findByRole("button", { name: "STOP BG" });
  await waitFor(() => expect(stop).toBeEnabled());
  server.answer("POST /program/main/scene-instant/stop", new Response("down", { status: 500 }));
  fireEvent.click(stop);
  await waitFor(() => expect(server.requests("POST /program/main/scene-instant/stop")).toHaveLength(1));
  await waitFor(() => expect(console.error).toHaveBeenCalledWith(
    "Failed to stop scene instant:",
    expect.any(Error),
  ));
  expect(stop).toBeEnabled();
});

it("takes a legacy instant's background audio when the scene names that instant", async () => {
  open(sceneWith({ instantId: 9 }), [
    { id: 9, name: "Fictional legacy pad", audioUrl: "https://media.example.test/legacy.mp3", assetId: "legacy-asset", volume: 1, enabled: true, position: 0 },
  ]);
  fireEvent.click(await screen.findByRole("tab", { name: "Background audio" }));
  fireEvent.click(await screen.findByRole("button", { name: "TAKE BG" }));
  await waitFor(() => expect(server.requests("POST /program/main/scene-instant/take")).toHaveLength(1));
  expect(server.requests("POST /program/main/scene-instant/take")[0]).toMatchObject({
    sceneId: 1,
    mediaAssetId: "legacy-asset",
  });
});
