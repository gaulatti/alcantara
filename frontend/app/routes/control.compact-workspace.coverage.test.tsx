import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  controlServer,
  stubConsoleBrowser,
  type ControlServer,
} from "../../test/controlKit";

// gaulatti/alcantara#404 (control.tsx stronger pass): the compact workspace (a phone's default) hides the scene
// workspace, and the director workspace shows it.

const workspace = vi.hoisted(() => ({ value: "compact" as string }));
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
      profile: {
        ...actual.defaultConsoleProfile("desktop"),
        workspace: workspace.value,
      },
      updateProfile: vi.fn(),
    }),
  };
});

import Control from "./control";

let server: ControlServer;


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

const sceneWorkspace = () =>
  document.querySelector<HTMLElement>(".console-scene-workspace");

it("hides the scene workspace in the compact workspace", async () => {
  workspace.value = "compact";
  open(headlines);
  await screen.findAllByRole("button", { name: /Fictional headlines/ });
  expect(sceneWorkspace()).toHaveAttribute("data-workspace-content", "compact");
  expect(sceneWorkspace()).toHaveClass("hidden");
});

it("shows the scene workspace in the director workspace", async () => {
  workspace.value = "director";
  open(headlines);
  await screen.findAllByRole("button", { name: /Fictional headlines/ });
  expect(sceneWorkspace()).toHaveAttribute(
    "data-workspace-content",
    "director",
  );
  expect(sceneWorkspace()).not.toHaveClass("hidden");
});
