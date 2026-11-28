import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ManualRundown from "./ManualRundown";
import { fetchFlightSequences } from "../services/flight";

const events = vi.hoisted(() => ({ onMessage: null as null | ((data: unknown) => void) }));
vi.mock("../hooks/useProgramEvents", () => ({
  useProgramEvents: (options: { onMessage: (data: unknown) => void }) => {
    events.onMessage = options.onMessage;
  },
}));
vi.mock("../utils/globalProgram", () => ({ useGlobalProgramId: () => ["main"] }));
vi.mock("../services/flight", async (original) => ({
  ...(await original<typeof import("../services/flight")>()),
  fetchFlightSequences: vi.fn(),
}));

const rundown = (id: number, name: string) =>
  ({ id, name, items: [], loop: false, isRunning: false, activeItemId: null, scheduledAt: null, revision: 1 }) as any;
const changed = (programId = "main") =>
  act(async () => {
    events.onMessage!({ type: "flight_update", programId, sequencesChanged: true, activeSequenceId: null, runtime: null });
  });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("lists a rundown created elsewhere when the event says the list changed", async () => {
  vi.mocked(fetchFlightSequences).mockResolvedValueOnce([]).mockResolvedValue([rundown(7, "Made elsewhere")]);
  render(<ManualRundown />);
  await screen.findByText("No rundowns yet");
  await changed("another show");
  expect(fetchFlightSequences).toHaveBeenCalledTimes(1);
  await changed();
  expect(await screen.findByText("Runtime")).toBeVisible();
  expect(screen.queryByText("No rundowns yet")).toBeNull();
});

it("keeps the list it has when reading it again fails", async () => {
  vi.mocked(fetchFlightSequences).mockResolvedValueOnce([rundown(1, "Main show")]).mockRejectedValue(new Error("offline"));
  render(<ManualRundown />);
  await screen.findByText("Runtime");
  await changed();
  expect(screen.getByText("Runtime")).toBeVisible();
  expect(screen.queryByText("No rundowns yet")).toBeNull();
});
