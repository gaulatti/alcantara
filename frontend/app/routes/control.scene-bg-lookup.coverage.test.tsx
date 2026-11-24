import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser } from "../../test/controlKit";

// gaulatti/alcantara#404 (control.tsx stronger pass): a staged scene's background audio comes from its own asset, or,
// for a scene saved before assets, from the asset of the cartwall instant it names. An asset or instant that is no
// longer in the library leaves nothing ready to take.

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

const bedScene = (sceneInstant: Record<string, unknown>) => ({
  id: 2,
  name: "Fictional bed scene",
  layoutId: 2,
  metadata: JSON.stringify({ player: { show: true }, sceneInstant }),
  layout: { id: 2, name: "Player layout", componentType: "player" },
});

function open(sceneInstant: Record<string, unknown>, instants: unknown[] = []) {
  const bed = bedScene(sceneInstant);
  controlServer({
    "GET /scenes": Response.json([bed]),
    "GET /instants": Response.json(instants),
    "GET /songs?limit=0": Response.json({ data: [] }),
    "GET /program/main/state": Response.json({
      id: 1,
      programId: "main",
      type: "tv",
      version: 5,
      activeSceneId: null,
      stagedSceneId: 2,
      stagedScene: bed,
      fadeToBlack: false,
      scenes: [{ id: 1, sceneId: 2, position: 0, scene: bed }],
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

const bell = {
  id: 7,
  name: "Fictional bell",
  audioUrl: "https://media.example.test/bell.mp3",
  position: 0,
  enabled: true,
  volume: 1,
  assetId: "a1",
};

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

it("readies the asset of the cartwall instant a scene saved before assets names", async () => {
  open({ assetId: null, instantId: 7 }, [bell]);
  expect(await screen.findByText("Ready: Fictional rain")).toBeVisible();
  expect(screen.getByRole("button", { name: "TAKE BG" })).toBeEnabled();
});

it("readies nothing for an asset that is no longer in the library", async () => {
  open({ assetId: "a-gone", instantId: null });
  expect(
    await screen.findByText(
      "Select background audio, then press SAVE (or TAKE BG).",
    ),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "TAKE BG" })).toBeDisabled();
});

it("readies nothing for an instant that is no longer in the cartwall", async () => {
  open({ assetId: null, instantId: 99 }, [bell]);
  expect(
    await screen.findByText(
      "Select background audio, then press SAVE (or TAKE BG).",
    ),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "TAKE BG" })).toBeDisabled();
});
