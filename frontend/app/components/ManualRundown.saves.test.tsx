import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ManualRundown from "./ManualRundown";
import type { FlightCue, FlightSequence } from "../models/broadcast";
import { deleteFlightSequence, fetchFlightSequences, updateFlightSequence } from "../services/flight";

// Quick successive cue edits must all survive, even when the server answers
// the saves out of order: each edit builds on the newest items, and an older
// answer never replaces a newer edit.

vi.mock("../hooks/useSSE", () => ({
  useSSE: () => ({ isConnected: true, error: null }),
}));
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => ["main"],
}));
vi.mock("../services/flight", () => ({
  activateFlightSequence: vi.fn(),
  createFlightSequence: vi.fn(),
  deactivateFlightSequence: vi.fn(),
  deleteFlightSequence: vi.fn(),
  fetchFlightSequences: vi.fn(),
  goFlight: vi.fn(),
  resetFlight: vi.fn(),
  startFlight: vi.fn(),
  stopFlight: vi.fn(),
  updateFlightSequence: vi.fn(),
}));

const base = (items: FlightCue[]): FlightSequence => ({
  id: 1,
  name: "Main show",
  revision: 1,
  items,
  scheduledAt: null,
  publishedAt: null,
  lastStartedAt: null,
  isRunning: false,
  activeItemId: null,
  loop: false,
  createdAt: "",
  updatedAt: "",
});

interface PendingSave {
  body: { items?: FlightCue[]; loop?: boolean };
  answer: () => void;
  refuse: (message: string) => void;
}

/**
 * A server that applies a save when it answers it. Saves wait until the test
 * answers them, newest first, so whenever two are in flight they finish out
 * of order.
 */
function slowServer(initial: FlightSequence) {
  let stored = initial;
  const pending: PendingSave[] = [];
  vi.mocked(updateFlightSequence).mockImplementation(
    (_program, _id, body) =>
      new Promise((resolve, reject) => {
        pending.push({
          body,
          answer: () => {
            stored = { ...stored, ...body, revision: stored.revision + 1 };
            resolve(stored);
          },
          refuse: (message) => reject(new Error(message)),
        });
      }),
  );
  const settle = () => act(async () => {});
  return {
    stored: () => stored,
    inFlight: () => pending.length,
    /** Takes the newest save that is in flight, once the page sent it. */
    async newest() {
      await settle();
      return pending.pop();
    },
    /** Answers every save, always the newest one first, until none is left. */
    async answerNewestFirst() {
      for (let round = 0; round < 20; round++) {
        await settle();
        const next = pending.pop();
        if (!next) return;
        await act(async () => next.answer());
      }
      throw new Error("saves never settled");
    },
  };
}

async function openRundown(items: FlightCue[]) {
  const server = slowServer(base(items));
  // A second rundown, which no edit of the first may touch.
  vi.mocked(fetchFlightSequences).mockResolvedValue([
    server.stored(),
    { ...base([]), id: 2, name: "Spare" },
  ]);
  render(<ManualRundown />);
  await screen.findByText(`Cue 0 of ${items.length}`);
  return server;
}

const labels = () => screen.getAllByPlaceholderText("Label (optional)");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/state"))
        return Response.json({ activeFlightSequenceId: 1, scenes: [] });
      if (url.includes("/songs")) return Response.json({ data: [] });
      return Response.json([]);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps both of two quick edits when the saves finish out of order", async () => {
  const server = await openRundown([
    { id: "a", kind: "stopSong" },
    { id: "b", kind: "waitForSongEnd" },
  ]);

  fireEvent.change(labels()[0], { target: { value: "Open" } });
  fireEvent.change(labels()[1], { target: { value: "Close" } });
  // Both edits show at once, before any save is answered.
  expect(labels().map((input) => (input as HTMLInputElement).value)).toEqual([
    "Open",
    "Close",
  ]);

  await server.answerNewestFirst();

  expect(server.inFlight()).toBe(0);
  expect(server.stored().items.map((cue) => cue.label)).toEqual([
    "Open",
    "Close",
  ]);
  expect(labels().map((input) => (input as HTMLInputElement).value)).toEqual([
    "Open",
    "Close",
  ]);
});

it("keeps every keystroke of a label typed faster than the saves", async () => {
  const server = await openRundown([{ id: "a", kind: "stopSong" }]);

  for (const value of ["N", "Ne", "New", "News"]) {
    fireEvent.change(labels()[0], { target: { value } });
  }
  expect(labels()[0]).toHaveValue("News");

  await server.answerNewestFirst();

  expect(server.stored().items[0].label).toBe("News");
  expect(labels()[0]).toHaveValue("News");
});

it("keeps a cue added right after an edit", async () => {
  const server = await openRundown([{ id: "a", kind: "stopSong" }]);

  fireEvent.change(labels()[0], { target: { value: "Open" } });
  fireEvent.click(screen.getByRole("button", { name: "Wait" }));
  expect(labels()).toHaveLength(2);

  await server.answerNewestFirst();

  expect(server.stored().items.map((cue) => cue.kind)).toEqual([
    "stopSong",
    "wait",
  ]);
  expect(server.stored().items[0].label).toBe("Open");
  expect(screen.getByText("Cue 0 of 2")).toBeVisible();
});

it("shows the saved items again when the newest save is refused", async () => {
  const server = await openRundown([
    { id: "a", kind: "stopSong", label: "Open" },
  ]);

  fireEvent.change(labels()[0], { target: { value: "Opening" } });
  expect(labels()[0]).toHaveValue("Opening");
  const save = await server.newest();
  await act(async () => save!.refuse("Rundown is locked"));

  expect(await screen.findByText("Rundown is locked")).toBeVisible();
  expect(labels()[0]).toHaveValue("Open");
  expect(server.stored().items[0].label).toBe("Open");
});

it("still saves a newer edit after an older save is refused", async () => {
  const server = await openRundown([
    { id: "a", kind: "stopSong" },
    { id: "b", kind: "waitForSongEnd" },
  ]);

  fireEvent.change(labels()[0], { target: { value: "Open" } });
  fireEvent.change(labels()[1], { target: { value: "Close" } });
  const first = await server.newest();
  await act(async () => first!.refuse("Try again"));
  expect(await screen.findByText("Try again")).toBeVisible();
  // The newer edit, which includes the first, is still shown and then saved.
  expect(labels()[1]).toHaveValue("Close");

  await server.answerNewestFirst();

  expect(server.stored().items.map((cue) => cue.label)).toEqual([
    "Open",
    "Close",
  ]);
});

it("keeps unsaved cue edits when the loop answer arrives first", async () => {
  const server = await openRundown([{ id: "a", kind: "stopSong" }]);

  fireEvent.change(labels()[0], { target: { value: "Open" } });
  const labelSave = await server.newest();
  fireEvent.click(screen.getByRole("button", { name: /Loop off/ }));
  // The loop toggle is answered with the server's items, still without the label.
  await server.answerNewestFirst();
  expect(await screen.findByText("Loop on")).toBeVisible();
  expect(labels()[0]).toHaveValue("Open");

  await act(async () => labelSave!.answer());
  expect(server.stored().items[0].label).toBe("Open");
  expect(server.stored().loop).toBe(true);
  expect(labels()[0]).toHaveValue("Open");
});

it("keeps an edit when the cue is moved and another deleted before it is saved", async () => {
  const server = await openRundown([
    { id: "a", kind: "stopSong" },
    { id: "b", kind: "waitForSongEnd" },
    { id: "c", kind: "stopSong" },
  ]);

  fireEvent.change(labels()[0], { target: { value: "Open" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Move down" })[0]);
  fireEvent.click(screen.getAllByRole("button", { name: "Delete cue" })[2]);
  expect(labels().map((input) => (input as HTMLInputElement).value)).toEqual([
    "",
    "Open",
  ]);

  await server.answerNewestFirst();

  expect(server.stored().items.map((cue) => [cue.id, cue.label])).toEqual([
    ["b", undefined],
    ["a", "Open"],
  ]);
});

it("deletes the open sequence after confirming, and clears the cue list only for it", async () => {
  const server = await openRundown([]);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "Delete", exact: true }));
  expect(confirm).toHaveBeenCalledWith("Delete this flight sequence?");
  expect(deleteFlightSequence).not.toHaveBeenCalled();

  confirm.mockReturnValue(true);
  vi.mocked(deleteFlightSequence).mockResolvedValue(undefined as never);
  fireEvent.click(screen.getByRole("button", { name: "Delete", exact: true }));
  expect(await screen.findByText("Sequence deleted.")).toBeInTheDocument();
  expect(deleteFlightSequence).toHaveBeenCalledWith(expect.anything(), 1);
  expect(screen.queryByText(`Cue 0 of 0`)).toBeNull();
  expect(server.stored()).toBeTruthy();
  confirm.mockRestore();
});
