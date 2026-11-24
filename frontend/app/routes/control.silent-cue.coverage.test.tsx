import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#404 (control.tsx guards): a cartwall clip with no audio file still lists and plays; its length is
// never read, so nothing waits for a duration.

vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: false }) }));
vi.mock("../utils/globalProgram", () => ({ useGlobalProgramId: () => ["main"] }));
vi.mock("../contexts/ConsolePreferencesContext", async (original) => {
  const actual = await original<typeof import("../contexts/ConsolePreferencesContext")>();
  return { ...actual, useConsolePreferences: () => ({ profile: actual.defaultConsoleProfile("desktop"), updateProfile: vi.fn() }) };
});

import Control from "./control";

let server: ControlServer;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  stubConsoleBrowser();
  server = controlServer({
    "GET /scenes": Response.json([]),
    "GET /instants": Response.json([
      { id: 3, name: "Fictional silent cue", audioUrl: null, volume: 1, enabled: true, position: 0 },
    ]),
    "GET /songs?limit=0": Response.json([]),
    "GET /program/main/state": Response.json({ id: 1, programId: "main", type: "radio", activeSceneId: null, fadeToBlack: false, scenes: [], mediaGroups: [] }),
    "GET /program/main/media-groups": Response.json([]),
    "POST /instants/3/play?programId=main": Response.json({}),
  });
  render(<MemoryRouter><Control /></MemoryRouter>);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("lists a cartwall clip with no audio file and plays it without waiting for a length", async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Fictional silent cue" }));
  await waitFor(() => expect(server.requests("POST /instants/3/play?programId=main")).toHaveLength(1));
  expect(screen.queryByText(/Could not play/)).toBeNull();
});
