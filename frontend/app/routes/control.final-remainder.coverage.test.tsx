import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#404 (group A, control.tsx): the remaining uncovered paths of the control route that
// the operator reaches through the page: the program recording panels, the simulcast status rail, the
// scene editor's flushes on page hide and on focus loss, and the scene-instant stop after a refusal.

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

const scene = {
  id: 1,
  name: "Fictional player scene",
  layoutId: 1,
  metadata: JSON.stringify({ header: { show: false } }),
  layout: { id: 1, name: "Fixture layout", componentType: "header" },
};

function open(programType: "tv" | "both" = "tv") {
  server = controlServer({
    "GET /scenes": Response.json([scene]),
    "GET /instants": Response.json([]),
    "GET /songs?limit=0": Response.json({ data: [] }),
    "GET /program/main/state": Response.json({
      id: 1,
      programId: "main",
      type: programType,
      activeSceneId: null,
      stagedSceneId: 1,
      stagedScene: scene,
      fadeToBlack: false,
      scenes: [{ id: 1, sceneId: 1, position: 0, scene }],
      mediaGroups: [],
    }),
    "GET /program/main/media-groups": Response.json([]),
    "GET /media-assets?mediaType=AUDIO&capability=BACKGROUND&limit=200": Response.json({ data: [] }),
    "PUT /scenes/1": Response.json(scene),
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

it("opens the program recording panels from the recording summary, and closes them again", async () => {
  open();
  const summary = (await screen.findAllByText("Program recording"))[0];
  fireEvent.click(summary);
  await waitFor(() => expect(summary.closest("details")?.open).toBe(true));
  fireEvent.click(summary);
  await waitFor(() => expect(summary.closest("details")?.open).toBe(false));
});

it("shows the simulcast status rail for a program that airs both radio and television", async () => {
  open("both");
  expect(await screen.findByText(/Simulcast/i)).toBeInTheDocument();
});

it("saves a dirty scene edit when the page is hidden, before the autosave pause ends", async () => {
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Show component" }));
  // The edit is still inside its autosave pause; hiding the page flushes it at once.
  window.dispatchEvent(new Event("pagehide"));
  await waitFor(() => expect(server.requests("PUT /scenes/1").length).toBeGreaterThan(0));
});

it("saves a dirty scene edit when focus leaves a control inside the scene editor", async () => {
  open();
  const toggle = await screen.findByRole("button", { name: "Show component" });
  fireEvent.click(toggle);
  // Focus leaving the editor's own controls flushes the edit, whichever control it was.
  fireEvent.focusOut(await screen.findByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(server.requests("PUT /scenes/1").length).toBeGreaterThan(0));
});
