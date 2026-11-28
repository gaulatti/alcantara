import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ManualRundown from "./ManualRundown";
import { fetchFlightSequences, updateFlightSequence } from "../services/flight";

const events = vi.hoisted(() => ({ onMessage: null as null | ((data: unknown) => void) }));
vi.mock("../hooks/useProgramEvents", () => ({
  useProgramEvents: (options: { onMessage: (data: unknown) => void }) => {
    events.onMessage = options.onMessage;
  },
}));
const shown = vi.hoisted(() => ({ program: "main" }));
vi.mock("../utils/globalProgram", () => ({ useGlobalProgramId: () => [shown.program] }));
vi.mock("../services/flight", async (original) => ({
  ...(await original<typeof import("../services/flight")>()),
  fetchFlightSequences: vi.fn(),
  updateFlightSequence: vi.fn(),
}));

const rundown = (id: number, name: string) =>
  ({ id, name, items: [], loop: false, isRunning: false, activeItemId: null, scheduledAt: null, revision: 1 }) as any;
const changed = (programId = "main", activeSequenceId: number | null = null) =>
  act(async () => {
    events.onMessage!({ type: "flight_update", programId, sequencesChanged: true, activeSequenceId, runtime: null });
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
  shown.program = "main";
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

it("keeps a cue edit the server has not confirmed when the list is read again", async () => {
  vi.mocked(fetchFlightSequences).mockResolvedValue([rundown(1, "Main show")]);
  vi.mocked(updateFlightSequence).mockReturnValue(new Promise(() => {}));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => new Response(String(url).includes("/control/state") ? '{"activeFlightSequenceId":1}' : "[]")),
  );
  render(<ManualRundown />);
  await screen.findByText("Runtime");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Wait$/ }));
  });
  expect(screen.queryByText("No cues yet")).toBeNull();
  const added = screen.getAllByRole("button").length;
  await changed("main", 1);
  expect(fetchFlightSequences).toHaveBeenCalledTimes(2);
  expect(screen.getAllByRole("button")).toHaveLength(added);
});

it("drops a list that arrives after another program is on screen", async () => {
  let finish!: (value: any[]) => void;
  vi.mocked(fetchFlightSequences)
    .mockResolvedValueOnce([])
    .mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
    .mockResolvedValue([]);
  const { rerender } = render(<ManualRundown />);
  await screen.findByText("No rundowns yet");
  await changed();
  shown.program = "other";
  await act(async () => rerender(<ManualRundown />));
  await act(async () => finish([rundown(7, "Made for the old program")]));
  expect(screen.getByText("No rundowns yet")).toBeVisible();
});
