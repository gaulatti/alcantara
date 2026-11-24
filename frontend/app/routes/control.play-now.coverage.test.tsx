import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  controlServer,
  stubConsoleBrowser,
  type ControlServer,
} from "../../test/controlKit";

// gaulatti/alcantara#404 (group A, control.tsx): a library song taken on air now from the radio desk. The
// dialog hands the chosen song to the route, which posts it to the program's radio.

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

const harbor = {
  id: 77,
  title: "Harbor Library Cut",
  artist: "Fictional artist",
  audioUrl: "https://media.example.test/harbor.mp3",
  coverUrl: "https://media.example.test/harbor.jpg",
  durationMs: 200_000,
  enabled: true,
};

function open(songPost: () => Response = () => Response.json({})) {
  server = controlServer({
    "GET /scenes": Response.json([]),
    "GET /instants": Response.json([]),
    "GET /songs?limit=0": Response.json({ data: [harbor] }),
    "GET /program/main/state": Response.json({
      id: 1,
      programId: "main",
      type: "radio",
      activeSceneId: null,
      fadeToBlack: false,
      scenes: [],
      mediaGroups: [],
    }),
    "GET /program/main/media-groups": Response.json([]),
    "POST /radio/main/song": songPost,
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

it("takes a library song on air now, and posts it to the program's radio once confirmed", async () => {
  open();
  // The radio panel (which owns the "/" shortcut) mounts only after the program state loads.
  await waitFor(() =>
    expect(screen.queryByText(/Loading main control surface/)).toBeNull(),
  );
  fireEvent.keyDown(window, { key: "/" });
  const dialog = await screen.findByRole("dialog", { name: "Play a song now" });
  fireEvent.change(
    within(dialog).getByRole("textbox", {
      name: "Search the rotation and the library",
    }),
    { target: { value: "harbor" } },
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Take now Harbor Library Cut" }),
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Confirm Harbor Library Cut" }),
  );
  await waitFor(() =>
    expect(server.requests("POST /radio/main/song")).toHaveLength(1),
  );
  expect(server.requests("POST /radio/main/song")[0]).toMatchObject({
    songId: 77,
    title: "Harbor Library Cut",
    artist: "Fictional artist",
  });
});

// gaulatti/alcantara#404 (control.tsx stronger pass): a play the radio refuses is shown in the dialog with the
// radio's own reason.
it("shows why the radio refused a library song taken on air now", async () => {
  open(() =>
    Response.json({ message: "Palazzo is not ready" }, { status: 409 }),
  );
  await waitFor(() =>
    expect(screen.queryByText(/Loading main control surface/)).toBeNull(),
  );
  fireEvent.keyDown(window, { key: "/" });
  const dialog = await screen.findByRole("dialog", { name: "Play a song now" });
  fireEvent.change(
    within(dialog).getByRole("textbox", {
      name: "Search the rotation and the library",
    }),
    { target: { value: "harbor" } },
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Take now Harbor Library Cut" }),
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Confirm Harbor Library Cut" }),
  );
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Palazzo is not ready",
  );
  expect(server.requests("POST /radio/main/song")).toHaveLength(1);
});
