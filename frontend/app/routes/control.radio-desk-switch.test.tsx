import {
  act,
  cleanup,
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

// The Radio desk's own reads (engine status, stream, output confidence, recovery, rundown) answered after the
// operator switched to another radio program change nothing on that program's desk.

vi.setConfig({ testTimeout: 30_000 });

const desk = vi.hoisted(() => ({ program: "main" }));
vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: true }) }));
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => [desk.program],
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

const programState = (programId: string) => ({
  id: programId === "main" ? 1 : 2,
  programId,
  type: "radio",
  activeSceneId: null,
  fadeToBlack: false,
  scenes: [],
  mediaGroups: [],
});

const palazzo = (
  programId: string,
  connection: "connected" | "unavailable",
) => ({
  programId,
  programType: "radio",
  palazzoUrl: "http://palazzo:3100",
  instanceId: `fake-${programId}`,
  connection,
  lastEventAt: new Date().toISOString(),
  lastSnapshotAt: new Date().toISOString(),
  degraded: false,
  detail: null,
});

const view = () => (
  <MemoryRouter>
    <Control />
  </MemoryRouter>
);

beforeEach(() => {
  desk.program = "main";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  stubConsoleBrowser();
  server = controlServer({
    "GET /scenes": Response.json([]),
    "GET /instants": Response.json([]),
    "GET /songs?limit=0": Response.json({ data: [] }),
    ...Object.fromEntries(
      ["main", "other"].flatMap((id) => [
        [`GET /program/${id}/state`, () => Response.json(programState(id))],
        [`GET /program/${id}/media-groups`, () => Response.json([])],
        [
          `GET /program/${id}/audio-bus`,
          () => Response.json({ songSequence: null, songQueue: [] }),
        ],
        [
          `GET /radio/${id}/status`,
          () => Response.json({ running: true, uptime: 60_000 }),
        ],
        [
          `GET /radio/${id}/output-confidence`,
          () =>
            Response.json({
              state: "idle",
              expectedAudio: false,
              outputRms: 0,
              lastSampleAt: new Date().toISOString(),
              quietForMs: null,
            }),
        ],
        [
          `GET /radio/${id}/recovery`,
          () =>
            Response.json({
              preparedVersion: null,
              automation: null,
              connection: "connected",
            }),
        ],
        [`GET /program/${id}/flight`, () => Response.json([])],
        [
          `GET /radio/${id}/palazzo-status`,
          () => Response.json(palazzo(id, "connected")),
        ],
      ]),
    ),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("does not show the program left's engine status on the program switched to", async () => {
  let answerMain: (response: Response) => void = () => {};
  server.answer(
    "GET /radio/main/palazzo-status",
    () =>
      new Promise<Response>((resolve) => {
        answerMain = resolve;
      }),
  );
  const rendered = render(view());
  await screen.findByRole("region", { name: "On air" });
  await waitFor(() =>
    expect(
      server.requests("GET /radio/main/palazzo-status").length,
    ).toBeGreaterThan(0),
  );

  desk.program = "other";
  rendered.rerender(view());
  const strip = () => screen.getByRole("region", { name: "On air" });
  await waitFor(() =>
    expect(within(strip()).getByText("Engine ready")).toBeVisible(),
  );

  // main's engine answers late: unavailable.
  await act(async () => {
    answerMain(Response.json(palazzo("main", "unavailable")));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(within(strip()).getByText("Engine ready")).toBeVisible();
  expect(within(strip()).queryByText(/Engine unavailable/)).toBeNull();
});
