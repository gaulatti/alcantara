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
        stagedSceneId: 1,
        stagedScene: headlines,
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

const reasons: Array<[string, () => Response]> = [
  ["a JSON 500", refused],
  [
    "a 401",
    () =>
      Response.json(
        { statusCode: 401, message: "Unauthorized" },
        { status: 401 },
      ),
  ],
  ["a body that is not a list", () => Response.json({ data: [] })],
];

it.each(
  reasons.flatMap(([reason, answer]) => [
    ["GET /scenes", reason, answer, "Scenes could not be loaded."] as const,
    [
      "GET /layouts",
      reason,
      answer,
      "Scene templates could not be loaded.",
    ] as const,
  ]),
)(
  "keeps the console open and says so when %s answers %s",
  async (request, _reason, answer, message) => {
    server.answer(request, answer);
    render(<Control />);
    expect(
      (await screen.findAllByText("Fictional headlines")).length,
    ).toBeGreaterThan(0);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      `${message} The list may be out of date.`,
    );
  },
);

it("keeps the last good scene list when a reload fails, and retries both catalogs", async () => {
  server.answer("GET /layouts", refused);
  render(<Control />);
  expect(
    await screen.findByRole("heading", {
      name: "Prepare · Fictional headlines",
    }),
  ).toBeVisible();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Scene templates could not be loaded.",
  );

  // The scene list is the one that fails this time; the console keeps the last
  // good list and says it may be out of date.
  server.answer("GET /scenes", refused);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(server.requests("GET /scenes")).toHaveLength(2));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Scenes could not be loaded. The list may be out of date.",
  );
  expect(
    screen.getByRole("heading", { name: "Prepare · Fictional headlines" }),
  ).toBeVisible();

  // Both answer again: the message goes.
  server.answer(
    "GET /scenes",
    Response.json([scene(1, "Fictional headlines")]),
  );
  server.answer("GET /layouts", Response.json([]));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
});

it("lets the operator dismiss the message", async () => {
  server.answer("GET /scenes", refused);
  render(<Control />);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("shows no catalog message when both load", async () => {
  render(<Control />);
  await screen.findAllByText("Fictional headlines");
  await waitFor(() => expect(server.requests("GET /layouts")).toHaveLength(1));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
