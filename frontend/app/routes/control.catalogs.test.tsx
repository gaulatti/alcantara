import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  controlServer,
  stubConsoleBrowser,
  type ControlServer,
} from "../../test/controlKit";

// A scene or layout catalog the backend refuses must not take the console
// down, and the operator must see that it did not load.

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

const scene = (id: number, name: string) => ({
  id,
  name,
  layoutId: 1,
  metadata: {},
  layout: { id: 1, name: "Fixture layout", componentType: "toni-clock" },
});

const refused = () =>
  Response.json(
    { statusCode: 500, message: "Internal server error" },
    { status: 500 },
  );

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  stubConsoleBrowser();
  const headlines = scene(1, "Fictional headlines");
  server = controlServer({
    "GET /scenes": Response.json([headlines]),
    "GET /layouts": Response.json([]),
    "GET /program/main/state": () =>
      Response.json({
        id: 1,
        programId: "main",
        type: "tv",
        activeSceneId: 1,
        activeScene: headlines,
        fadeToBlack: false,
        scenes: [{ id: 1, sceneId: 1, position: 0, scene: headlines }],
        mediaGroups: [],
      }),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ["GET /scenes", "Scenes could not be loaded. Refresh to try again."],
  [
    "GET /layouts",
    "Scene templates could not be loaded. Refresh to try again.",
  ],
])(
  "keeps the console open and says so when %s answers an error body",
  async (request, message) => {
    server.answer(request, refused);
    render(<Control />);
    expect(
      (await screen.findAllByText("Fictional headlines")).length,
    ).toBeGreaterThan(0);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  },
);

it("says so when a catalog answers something other than a list", async () => {
  server.answer("GET /scenes", Response.json({ data: [] }));
  server.answer("GET /layouts", Response.json({ data: [] }));
  render(<Control />);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Scenes could not be loaded.");
  expect(alert).toHaveTextContent("Scene templates could not be loaded.");
});

it("shows no catalog error when both load", async () => {
  render(<Control />);
  await screen.findAllByText("Fictional headlines");
  await waitFor(() => expect(server.requests("GET /layouts")).toHaveLength(1));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
