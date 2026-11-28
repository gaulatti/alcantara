import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ScheduledRundown from "./ScheduledRundown";
import { fetchFlightSequences } from "../services/flight";
import type { ProgramEventsConnection } from "../hooks/useProgramEvents";

const events = vi.hoisted(() => ({
  onMessage: null as null | ((data: unknown) => void),
  onConnection: null as null | ((state: ProgramEventsConnection) => void),
}));
vi.mock("../hooks/useProgramEvents", () => ({
  useProgramEvents: (options: any) => {
    events.onMessage = options.onMessage;
    events.onConnection = options.onConnectionStateChange;
  },
}));
vi.mock("../utils/globalProgram", () => ({ useGlobalProgramId: () => ["radio-demo"] }));
vi.mock("../services/flight", async (original) => ({
  ...(await original<typeof import("../services/flight")>()),
  fetchFlightSequences: vi.fn(),
}));

const block = (id: number, hour: number, items: unknown[] = []) =>
  ({
    id,
    name: `Block ${id}`,
    scheduledAt: `2030-01-01T${String(hour).padStart(2, "0")}:00:00.000Z`,
    items,
    revision: 1,
    loop: false,
    isRunning: false,
    activeItemId: null,
    publishedAt: null,
    lastStartedAt: null,
  }) as any;
const first = block(1, 10, [{ id: "c1", kind: "instant", instantId: 9, durationMs: 60_000 }]);
const second = block(2, 11);

const send = (data: Record<string, unknown>) => act(async () => events.onMessage!(data));
const changed = () => send({ type: "flight_update", programId: "radio-demo", sequencesChanged: true });
const connection = (state: ProgramEventsConnection) => act(async () => events.onConnection!(state));
const chooser = () => screen.getByRole("combobox", { name: "Scheduled block" });
const open = () =>
  render(
    <MemoryRouter>
      <ScheduledRundown />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const path = String(url);
      if (path.includes("/audio-bus")) return Response.json({ songSequence: { items: [] } });
      if (path.includes("/songs")) return Response.json({ data: [], meta: { totalPages: 1 } });
      return Response.json([{ id: 9, name: "Sounder" }]);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("reads the list again for a block created elsewhere, and on a reconnect, and for nothing else", async () => {
  vi.mocked(fetchFlightSequences).mockResolvedValue([]);
  open();
  await screen.findByText("No timed block selected");
  await send({ type: "flight_update", programId: "radio-demo" });
  await send({ type: "flight_update", programId: "other", sequencesChanged: true });
  await connection("connected");
  expect(fetchFlightSequences).toHaveBeenCalledTimes(1);
  vi.mocked(fetchFlightSequences).mockResolvedValue([first]);
  await changed();
  expect(await screen.findByRole("table", { name: "Scheduled rundown events" })).toBeVisible();
  await connection("disconnected");
  await connection("connected");
  expect(fetchFlightSequences).toHaveBeenCalledTimes(3);
});

it("keeps unsaved events when the list is read again, even if the block is gone", async () => {
  vi.mocked(fetchFlightSequences).mockResolvedValue([first, second]);
  open();
  const table = await screen.findByRole("table", { name: "Scheduled rundown events" });
  fireEvent.click(within(table).getAllByRole("button")[0]);
  fireEvent.change(screen.getByRole("spinbutton", { name: "Clip duration" }), { target: { value: "120" } });
  expect(screen.getByText(/Unsaved changes/)).toBeVisible();
  vi.mocked(fetchFlightSequences).mockResolvedValue([{ ...first, revision: 2 }, second]);
  await changed();
  expect(screen.getByText(/Unsaved changes/)).toBeVisible();
  vi.mocked(fetchFlightSequences).mockResolvedValue([second]);
  await changed();
  expect(screen.getByText(/Unsaved changes/)).toBeVisible();
  expect(chooser()).toBeDisabled();
});

it("moves off a deleted block that has no edits, and keeps the list when the reread fails", async () => {
  vi.mocked(fetchFlightSequences).mockResolvedValue([first, second]);
  open();
  await screen.findByRole("table", { name: "Scheduled rundown events" });
  vi.mocked(fetchFlightSequences).mockResolvedValue([second]);
  await changed();
  expect(screen.getByText(/0 events/)).toBeVisible();
  vi.mocked(fetchFlightSequences).mockResolvedValue([]);
  await changed();
  expect(screen.getByText("No timed block selected")).toBeVisible();
  vi.mocked(fetchFlightSequences).mockResolvedValue([second]);
  await changed();
  expect(screen.getByText(/0 events/)).toBeVisible();
  vi.mocked(fetchFlightSequences).mockRejectedValue(new Error("offline"));
  await changed();
  expect(screen.getByText(/0 events/)).toBeVisible();
});
