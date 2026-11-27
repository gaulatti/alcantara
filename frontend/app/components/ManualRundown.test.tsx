import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor as settleWaitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ManualRundown from "./ManualRundown";
import type { FlightSequence } from "../models/broadcast";
import {
  activateFlightSequence,
  createFlightSequence,
  deactivateFlightSequence,
  deleteFlightSequence,
  fetchFlightSequences,
  goFlight,
  resetFlight,
  startFlight,
  stopFlight,
  updateFlightSequence,
} from "../services/flight";
import {
  rundown,
  scene,
  stubDialog,
  stubLibrary,
} from "../../test/manualRundownKit";

// The operator-cue rundown: its rundowns, activation, runtime controls and the
// live updates it follows. The cue editors are covered in
// ManualRundown.cues.test.tsx.

const sse = vi.hoisted(() => ({
  onMessage: null as null | ((data: unknown) => void),
}));
vi.mock("../hooks/useSSE", () => ({
  useSSE: ({ onMessage }: { onMessage: (data: unknown) => void }) => {
    sse.onMessage = onMessage;
    return { isConnected: true, error: null };
  },
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
vi.mock("@gaulatti/bleecker", async (original) => {
  const kit = await import("../../test/manualRundownKit");
  return kit.nativeSelect(
    original as () => Promise<typeof import("@gaulatti/bleecker")>,
  );
});

const SHOW = rundown(1, "Main show", [
  { id: "open", kind: "scene", label: "Open on wide", sceneId: 3 },
  { id: "music", kind: "playSong", label: "Theme", songId: 1 },
  { id: "close", kind: "stopSong", label: "Close" },
]);
const SPARE = rundown(2, "Spare", []);

let store: FlightSequence[] = [];

beforeEach(() => {
  stubDialog();
  vi.spyOn(console, "error").mockImplementation(() => {});
  store = [
    SHOW,
    SPARE,
    rundown(9, "Timed", [], { scheduledAt: "2026-11-17T10:00:00Z" }),
  ];
  vi.mocked(fetchFlightSequences).mockImplementation(async () => store);
  vi.mocked(updateFlightSequence).mockImplementation(
    async (_program, id, body) => {
      const current = store.find((sequence) => sequence.id === id)!;
      const updated = { ...current, ...body, revision: current.revision + 1 };
      store = store.map((sequence) =>
        sequence.id === id ? updated : sequence,
      );
      return updated;
    },
  );
});

/**
 * Waits for the condition, then lets the component apply the saved response:
 * the server stand-in updates its store before the component's own state.
 */
async function waitFor(check: () => void) {
  await settleWaitFor(check);
  await act(async () => {});
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sse.onMessage = null;
});

const chooser = () =>
  screen.getByDisplayValue(/Choose a rundown|Main show|Spare/);

async function openRundown(state: unknown = { activeFlightSequenceId: 1 }) {
  stubLibrary({ state });
  render(<ManualRundown />);
  await screen.findByText("Runtime");
}

it("loads the unscheduled rundowns and follows the one already running", async () => {
  stubLibrary({
    state: {
      activeFlightSequenceId: 1,
      scenes: [{ scene: scene(3, "Wide", null) }, { scene: null }],
    },
  });
  store = [
    { ...SHOW, isRunning: true, activeItemId: "music", loop: true },
    SPARE,
    rundown(9, "Timed", [], { scheduledAt: "2026-11-17T10:00:00Z" }),
  ];
  render(<ManualRundown />);
  expect(screen.getByText("Program: main")).toBeVisible();
  expect(await screen.findByText("Cue 2 of 3 (looping)")).toBeVisible();
  // Only the unscheduled rundowns are offered.
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(
    expect.arrayContaining(["Choose a rundown...", "Main show", "Spare"]),
  );
  expect(
    screen.queryByRole("option", { name: "Timed" }),
  ).not.toBeInTheDocument();
  expect(chooser()).toHaveValue("1");
  expect(screen.getByText("Active")).toBeVisible();
  expect(screen.getByText("Loop on")).toBeVisible();
  expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
  // Running: Stop reads as destructive and GO leads (they rendered the same blue before).
  expect(screen.getByRole("button", { name: "Stop" })).toHaveClass("bg-terracotta");
  expect(screen.getByRole("button", { name: /GO/ })).toHaveClass("bg-sea");
  // Active and next cue use the cue labels.
  expect(screen.getAllByText("Theme").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Close").length).toBeGreaterThan(0);
  expect(screen.getByRole("option", { name: "Wide" })).toBeInTheDocument();
});

it("opens an active rundown that is not running with no runtime yet", async () => {
  await openRundown();
  expect(await screen.findByText("Cue 0 of 3")).toBeVisible();
  expect(screen.getByText("Loop off")).toBeVisible();
  // The shared song picker sits on the console surface that defines its tokens.
  expect(
    screen.getByPlaceholderText("Search songs and clips").closest(".broadcast-console"),
  ).not.toBeNull();
  // Stopped: Start is the action to take, GO waits.
  expect(screen.getByRole("button", { name: "Start" })).toHaveClass("bg-sea");
  expect(screen.getByRole("button", { name: /GO/ })).not.toHaveClass("bg-sea");
  expect(screen.getAllByText("—")).toHaveLength(2);
  expect(screen.queryByText("Active")).not.toBeInTheDocument();
});

it("shows no active rundown when the program state is unavailable", async () => {
  stubLibrary({ stateOk: false });
  render(<ManualRundown />);
  expect(await screen.findByText("No active rundown.")).toBeVisible();
  expect(
    screen.getByText("Select or create a sequence to edit cues."),
  ).toBeVisible();
});

it("explains a rundown load failure and offers to create the first one", async () => {
  stubLibrary();
  vi.mocked(fetchFlightSequences).mockRejectedValue(new Error("offline"));
  render(<ManualRundown />);
  expect(await screen.findByText("Failed to load rundown data.")).toBeVisible();
  expect(screen.getByText("No rundowns yet")).toBeVisible();
});

it.each([
  [{ songsOk: false, instantsOk: false }],
  [{ songsThrow: true, instantsThrow: true }],
  [{ songs: { data: "nope" }, instants: { not: "a list" } }],
])(
  "still opens when the song or instant library is unavailable (%j)",
  async (library) => {
    stubLibrary({ state: { activeFlightSequenceId: 1 }, ...library });
    render(<ManualRundown />);
    expect(await screen.findByText("Cue 0 of 3")).toBeVisible();
  },
);

it("drops a load that finishes after the rundown closed", async () => {
  stubLibrary();
  let finish!: (value: FlightSequence[]) => void;
  vi.mocked(fetchFlightSequences).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = render(<ManualRundown />);
  view.unmount();
  await act(async () => finish([SHOW]));
  expect(screen.queryByText("Main show")).not.toBeInTheDocument();
});

it("creates a named rundown and ignores a blank name", async () => {
  stubLibrary();
  store = [];
  vi.mocked(createFlightSequence)
    .mockResolvedValueOnce(rundown(4, "Late show", []))
    .mockRejectedValueOnce(new Error("Name taken"));
  render(<ManualRundown />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Create rundown" }),
  );
  const name = screen.getByPlaceholderText("e.g. Main show rundown");

  fireEvent.change(name, { target: { value: "   " } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(createFlightSequence).not.toHaveBeenCalled();

  fireEvent.change(name, { target: { value: " Late show " } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(
    await screen.findByText('Sequence "Late show" created.'),
  ).toBeVisible();
  expect(createFlightSequence).toHaveBeenCalledWith("main", {
    name: "Late show",
    items: [],
  });
  expect(screen.getByRole("option", { name: "Late show" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /New rundown/ }));
  fireEvent.change(screen.getByPlaceholderText("e.g. Main show rundown"), {
    target: { value: "Late show" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(await screen.findByText("Name taken")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      screen.queryByPlaceholderText("e.g. Main show rundown"),
    ).not.toBeInTheDocument(),
  );
});

it("activates and deactivates a rundown from the chooser", async () => {
  await openRundown({ activeFlightSequenceId: null });
  vi.mocked(activateFlightSequence)
    .mockResolvedValueOnce(undefined as never)
    .mockRejectedValueOnce("busy");
  vi.mocked(deactivateFlightSequence)
    .mockResolvedValueOnce(undefined as never)
    .mockRejectedValueOnce(new Error("Cannot deactivate"));

  fireEvent.change(chooser(), { target: { value: "2" } });
  expect(await screen.findByText("Sequence activated.")).toBeVisible();
  expect(activateFlightSequence).toHaveBeenCalledWith("main", 2);
  expect(screen.getByText("No cues yet. Add one above.")).toBeVisible();

  fireEvent.change(chooser(), { target: { value: "" } });
  expect(await screen.findByText("Sequence deactivated.")).toBeVisible();
  expect(deactivateFlightSequence).toHaveBeenCalledWith("main");

  fireEvent.change(chooser(), { target: { value: "1" } });
  expect(await screen.findByText("busy")).toBeVisible();
  fireEvent.change(chooser(), { target: { value: "" } });
  expect(await screen.findByText("Cannot deactivate")).toBeVisible();
});

it("toggles looping and reports a failed toggle", async () => {
  await openRundown();
  // Loop is a toggle that says its state, and only an armed loop takes the primary colour.
  expect(screen.getByRole("button", { name: /Loop off/ })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: /Loop off/ })).not.toHaveClass("bg-sea");
  fireEvent.click(screen.getByRole("button", { name: /Loop off/ }));
  expect(await screen.findByText("Loop on")).toBeVisible();
  expect(screen.getByRole("button", { name: /Loop on/ })).toHaveAttribute("aria-pressed", "true");
  expect(updateFlightSequence).toHaveBeenCalledWith("main", 1, { loop: true });
  expect(screen.getByText("Cue 0 of 3 (looping)")).toBeVisible();

  vi.mocked(updateFlightSequence).mockRejectedValueOnce(new Error("Locked"));
  fireEvent.click(screen.getByRole("button", { name: /Loop on/ }));
  expect(await screen.findByText("Locked")).toBeVisible();
});

it("deletes the active rundown only after confirmation", async () => {
  await openRundown();
  const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
  vi.stubGlobal("confirm", confirm);
  // Delete reads as destructive and the cue buttons as secondary, never the primary blue.
  expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("bg-terracotta");
  expect(screen.getByRole("button", { name: /Wait for song end/ })).not.toHaveClass("bg-sea");
  vi.mocked(deleteFlightSequence)
    .mockRejectedValueOnce(new Error("In use"))
    .mockResolvedValueOnce(undefined as never);

  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(deleteFlightSequence).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(await screen.findByText("In use")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(await screen.findByText("Sequence deleted.")).toBeVisible();
  expect(deleteFlightSequence).toHaveBeenLastCalledWith("main", 1);
  expect(
    screen.queryByRole("option", { name: "Main show" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("No active rundown.")).toBeVisible();
});

it("adds each kind of cue and reports a cue that could not be saved", async () => {
  await openRundown();
  for (const label of [
    "Switch scene",
    "Play song",
    "Stop song",
    "Instant",
    "Mixer",
    "Wait",
    "Wait for song end",
    "Update scene",
  ]) {
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() =>
      expect(updateFlightSequence).toHaveBeenLastCalledWith("main", 1, {
        items: expect.any(Array),
      }),
    );
  }
  const items = store.find((sequence) => sequence.id === 1)!.items;
  expect(items.slice(3).map((cue) => cue.kind)).toEqual([
    "scene",
    "playSong",
    "stopSong",
    "instant",
    "mixer",
    "wait",
    "waitForSongEnd",
    "sceneUpdate",
  ]);
  expect(await screen.findByText("Cue 0 of 11")).toBeVisible();

  vi.mocked(updateFlightSequence).mockRejectedValueOnce(
    new Error("Too many cues"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Wait" }));
  expect(await screen.findByText("Too many cues")).toBeVisible();
});

it("runs the rundown from the runtime controls and reports each failure", async () => {
  await openRundown();
  for (const [control, call, done] of [
    [/Start/, startFlight, "Rundown started."],
    [/GO/, goFlight, "Advanced."],
    [/Reset/, resetFlight, "Rundown reset."],
  ] as const) {
    vi.mocked(call)
      .mockResolvedValueOnce(undefined as never)
      .mockRejectedValueOnce(new Error(`${done} failed`));
    fireEvent.click(screen.getByRole("button", { name: control }));
    expect(await screen.findByText(done)).toBeVisible();
    expect(call).toHaveBeenCalledWith("main");
    fireEvent.click(screen.getByRole("button", { name: control }));
    expect(await screen.findByText(`${done} failed`)).toBeVisible();
  }

  act(() =>
    sse.onMessage?.({
      type: "flight_update",
      programId: "main",
      activeSequenceId: 1,
      runtime: {
        sequenceId: 1,
        activeIndex: 0,
        isRunning: true,
        waitingForSongEnd: true,
        activeItemId: "open",
        totalItems: 3,
        loop: false,
      },
    }),
  );
  expect(screen.getByText("Waiting for song to end…")).toBeVisible();
  vi.mocked(stopFlight)
    .mockResolvedValueOnce(undefined as never)
    .mockRejectedValueOnce(new Error("Stop refused"));
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(await screen.findByText("Rundown stopped.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(await screen.findByText("Stop refused")).toBeVisible();
});

it("disables GO for a rundown without cues", async () => {
  store = [SPARE];
  await openRundown({ activeFlightSequenceId: 2 });
  expect(screen.getByRole("button", { name: /GO/ })).toBeDisabled();
});

it("follows live runtime, activation and scene updates for this program only", async () => {
  await openRundown({
    activeFlightSequenceId: 1,
    scenes: [{ scene: scene(3, "Wide", null) }],
  });
  const send = (data: unknown) => act(() => sse.onMessage?.(data));
  const running = {
    sequenceId: 1,
    activeIndex: 1,
    isRunning: true,
    waitingForSongEnd: false,
    activeItemId: "music",
    totalItems: 3,
    loop: false,
  };

  send(null);
  send("text");
  send({ type: "flight_update", programId: "other", runtime: running });
  expect(screen.getByText("Cue 0 of 3")).toBeVisible();

  // A runtime update without a sequence id keeps the active rundown.
  send({ type: "flight_update", programId: "main", runtime: running });
  expect(screen.getByText("Cue 2 of 3")).toBeVisible();
  expect(chooser()).toHaveValue("1");

  send({
    type: "program_scenes_changed",
    programId: "main",
    state: { scenes: [{ scene: scene(4, "Close-up", null) }] },
  });
  expect(screen.getByRole("option", { name: "Close-up" })).toBeInTheDocument();
  send({ type: "program_scenes_changed", programId: "main", state: {} });
  expect(
    screen.queryByRole("option", { name: "Close-up" }),
  ).not.toBeInTheDocument();
  send({
    type: "program_scenes_changed",
    programId: "other",
    state: { scenes: [{ scene: scene(5, "Elsewhere", null) }] },
  });
  expect(
    screen.queryByRole("option", { name: "Elsewhere" }),
  ).not.toBeInTheDocument();

  send({
    type: "program_scenes_changed",
    programId: "main",
    state: {
      scenes: [
        { scene: scene(3, "Wide", null) },
        { scene: scene(6, "Two-shot", null) },
      ],
    },
  });
  send({ type: "scene_update", scene: scene(3, "Wide (renamed)", null) });
  expect(
    screen.getByRole("option", { name: "Wide (renamed)" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Two-shot" })).toBeInTheDocument();
  send({ type: "scene_update" });
  expect(
    screen.getByRole("option", { name: "Wide (renamed)" }),
  ).toBeInTheDocument();

  send({ type: "flight_update", programId: "main", activeSequenceId: 2 });
  expect(chooser()).toHaveValue("2");
  expect(screen.getByText("Cue 0 of 0")).toBeVisible();

  send({ type: "flight_update", programId: "main", activeSequenceId: null });
  expect(screen.getByText("No active rundown.")).toBeVisible();
});
