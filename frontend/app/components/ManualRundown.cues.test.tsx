import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor as settleWaitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ManualRundown from "./ManualRundown";
import type { FlightCue, FlightSequence } from "../models/broadcast";
import { fetchFlightSequences, updateFlightSequence } from "../services/flight";
import {
  instant,
  rundown,
  scene,
  song,
  stubDialog,
  stubLibrary,
} from "../../test/manualRundownKit";

// The operator-cue editors of ManualRundown: each cue kind's fields, ordering,
// and the scene-update metadata editor. Every edit is saved to the flight API
// and the row shows what the server returned.

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
vi.mock("@gaulatti/bleecker", async (original) => {
  const kit = await import("../../test/manualRundownKit");
  return kit.nativeSelect(
    original as () => Promise<typeof import("@gaulatti/bleecker")>,
  );
});

let store: FlightSequence[] = [];
const saved = () => store[0].items;

beforeEach(() => {
  stubDialog();
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
  vi.unstubAllGlobals();
});

const SCENES = [
  scene(
    3,
    "Wide",
    JSON.stringify({ chyron: { text: "Hello", visible: true } }),
  ),
  scene(4, "Broken", "{not json"),
  scene(5, "Listy", "[1,2]"),
  scene(6, "Bare", null),
];

async function openCues(items: FlightCue[]) {
  store = [rundown(1, "Main show", items)];
  stubLibrary({
    state: {
      activeFlightSequenceId: 1,
      scenes: SCENES.map((entry) => ({ scene: entry })),
    },
    songs: {
      data: [
        song(1, "Harbor Light", "The Lighthouse Keepers"),
        song(2, "", ""),
      ],
    },
    instants: [instant(5, "Applause"), instant(6, "Laugh")],
  });
  render(<ManualRundown />);
  await screen.findByText(`Cue 0 of ${items.length}`);
}

/** The editor row of cue `index`, found from its number badge. */
function row(index: number) {
  const badge = screen
    .getAllByText(String(index + 1))
    .find((element) => element.className.includes("rounded-full"))!;
  return badge.closest<HTMLElement>('[class*="border-l-4"]')!;
}

const combos = (element: HTMLElement) =>
  within(element).getAllByRole("combobox");

it("changes a cue's kind and label", async () => {
  await openCues([{ id: "a", kind: "stopSong" }]);
  fireEvent.change(combos(row(0))[0], { target: { value: "wait" } });
  await waitFor(() => expect(saved()[0].kind).toBe("wait"));
  // A wait cue shows its duration, defaulting to 0 when none is set.
  expect(within(row(0)).getByRole("spinbutton")).toHaveValue(0);

  const label = within(row(0)).getByPlaceholderText("Label (optional)");
  fireEvent.change(label, { target: { value: "Hold" } });
  await waitFor(() => expect(saved()[0].label).toBe("Hold"));
  expect(screen.getByDisplayValue("Hold")).toBeVisible();
  fireEvent.change(label, { target: { value: "" } });
  await waitFor(() => expect(saved()[0].label).toBeUndefined());

  fireEvent.change(within(row(0)).getByRole("spinbutton"), {
    target: { value: "2500" },
  });
  await waitFor(() => expect(saved()[0].durationMs).toBe(2500));
});

it("moves and deletes cues, and keeps the ends from moving out of the list", async () => {
  await openCues([
    { id: "a", kind: "stopSong", label: "First" },
    { id: "b", kind: "waitForSongEnd", label: "Second" },
  ]);
  expect(
    within(row(0)).getByRole("button", { name: "Move up" }),
  ).toBeDisabled();
  expect(
    within(row(1)).getByRole("button", { name: "Move down" }),
  ).toBeDisabled();
  fireEvent.click(within(row(0)).getByRole("button", { name: "Move down" }));
  await waitFor(() => expect(saved().map((cue) => cue.id)).toEqual(["b", "a"]));
  fireEvent.click(within(row(1)).getByRole("button", { name: "Move up" }));
  await waitFor(() => expect(saved().map((cue) => cue.id)).toEqual(["a", "b"]));
  fireEvent.click(within(row(0)).getByRole("button", { name: "Delete cue" }));
  await waitFor(() => expect(saved().map((cue) => cue.id)).toEqual(["b"]));
  expect(screen.getByDisplayValue("Second")).toBeVisible();
});

it("edits a scene switch's scene and transition", async () => {
  await openCues([{ id: "a", kind: "scene" }]);
  const [, sceneSelect, transition] = combos(row(0));
  // A scene cue without a transition plays a cut.
  expect(transition).toHaveValue("cut");
  fireEvent.change(sceneSelect, { target: { value: "3" } });
  await waitFor(() => expect(saved()[0].sceneId).toBe(3));
  fireEvent.change(transition, { target: { value: "velvet-eclipse" } });
  await waitFor(() => expect(saved()[0].transitionId).toBe("velvet-eclipse"));
  fireEvent.change(combos(row(0))[1], { target: { value: "" } });
  await waitFor(() => expect(saved()[0].sceneId).toBeUndefined());
});

it("chooses a song and an instant, naming untitled songs", async () => {
  await openCues([
    { id: "a", kind: "playSong" },
    { id: "b", kind: "instant" },
  ]);
  const songSelect = combos(row(0))[1];
  expect(
    within(songSelect).getByRole("option", {
      name: "The Lighthouse Keepers - Harbor Light",
    }),
  ).toBeInTheDocument();
  expect(
    within(songSelect).getByRole("option", { name: "Unknown - Untitled" }),
  ).toBeInTheDocument();
  fireEvent.change(songSelect, { target: { value: "1" } });
  await waitFor(() => expect(saved()[0].songId).toBe(1));
  fireEvent.change(combos(row(0))[1], { target: { value: "" } });
  await waitFor(() => expect(saved()[0].songId).toBeUndefined());

  fireEvent.change(combos(row(1))[1], { target: { value: "6" } });
  await waitFor(() => expect(saved()[1].instantId).toBe(6));
  expect(combos(row(1))[1]).toHaveValue("6");
  fireEvent.change(combos(row(1))[1], { target: { value: "" } });
  await waitFor(() => expect(saved()[1].instantId).toBeUndefined());
});

it("sets a mixer change's channel, volume, mute and solo", async () => {
  await openCues([{ id: "a", kind: "mixer" }]);
  expect(within(row(0)).queryByText("Mute")).not.toBeInTheDocument();
  fireEvent.change(combos(row(0))[1], { target: { value: "main" } });
  await waitFor(() => expect(saved()[0].mixerChange?.channelId).toBe("main"));
  // The main bus cannot be soloed.
  expect(
    within(row(0)).queryByRole("button", { name: "Solo" }),
  ).not.toBeInTheDocument();

  fireEvent.change(combos(row(0))[1], { target: { value: "song" } });
  await waitFor(() => expect(saved()[0].mixerChange?.channelId).toBe("song"));
  const volume = within(row(0)).getByPlaceholderText("0-1");
  fireEvent.change(volume, { target: { value: "0.4" } });
  await waitFor(() => expect(saved()[0].mixerChange?.volume).toBe(0.4));
  fireEvent.change(within(row(0)).getByPlaceholderText("0-1"), {
    target: { value: "" },
  });
  await waitFor(() => expect(saved()[0].mixerChange?.volume).toBeUndefined());

  fireEvent.click(within(row(0)).getByRole("button", { name: "Mute" }));
  expect(
    await within(row(0)).findByRole("button", { name: "Muted" }),
  ).toBeVisible();
  fireEvent.click(within(row(0)).getByRole("button", { name: "Muted" }));
  expect(
    await within(row(0)).findByRole("button", { name: "Mute" }),
  ).toBeVisible();
  fireEvent.click(within(row(0)).getByRole("button", { name: "Solo" }));
  expect(
    await within(row(0)).findByRole("button", { name: "Soloed" }),
  ).toBeVisible();
  fireEvent.click(within(row(0)).getByRole("button", { name: "Soloed" }));
  expect(
    await within(row(0)).findByRole("button", { name: "Solo" }),
  ).toBeVisible();

  fireEvent.change(combos(row(0))[1], { target: { value: "" } });
  await waitFor(() =>
    expect(saved()[0].mixerChange?.channelId).toBeUndefined(),
  );
  expect(within(row(0)).queryByText("Mute")).not.toBeInTheDocument();
});

it("asks for a scene before editing a scene update", async () => {
  await openCues([{ id: "a", kind: "sceneUpdate" }]);
  expect(
    within(row(0)).getByText("Select a scene to edit its properties."),
  ).toBeVisible();
  fireEvent.change(combos(row(0))[1], { target: { value: "6" } });
  await waitFor(() => expect(saved()[0].sceneId).toBe(6));
  expect(
    await within(row(0)).findByText(
      "No properties yet. Add a component type above.",
    ),
  ).toBeVisible();
  fireEvent.change(combos(row(0))[1], { target: { value: "" } });
  await waitFor(() => expect(saved()[0].sceneId).toBeUndefined());
});

it.each([
  ["unparsable", 4],
  ["non-object", 5],
])("treats %s scene metadata as empty", async (_name, sceneId) => {
  await openCues([{ id: "a", kind: "sceneUpdate", sceneId }]);
  expect(
    within(row(0)).getByText("No properties yet. Add a component type above."),
  ).toBeVisible();
});

it("starts from the scene's metadata and saves an edited patch", async () => {
  await openCues([{ id: "a", kind: "sceneUpdate", sceneId: 3 }]);
  const editor = row(0);
  expect(
    within(editor).getByText("Showing current scene metadata"),
  ).toBeVisible();
  expect(within(editor).getByText("chyron")).toBeVisible();
  expect(within(editor).queryByText("New")).not.toBeInTheDocument();
  expect(within(editor).getByDisplayValue("Hello")).toBeVisible();

  // Editing a string property saves the whole effective metadata as the patch.
  fireEvent.change(within(editor).getByDisplayValue("Hello"), {
    target: { value: "Good evening" },
  });
  await waitFor(() =>
    expect(saved()[0].metadataPatch).toEqual({
      chyron: { text: "Good evening", visible: true },
    }),
  );
  expect(
    await within(row(0)).findByText("Editing effective metadata"),
  ).toBeVisible();

  // Booleans toggle.
  fireEvent.click(within(row(0)).getByRole("button", { name: "true" }));
  await waitFor(() =>
    expect(saved()[0].metadataPatch).toEqual({
      chyron: { text: "Good evening", visible: false },
    }),
  );
  fireEvent.click(await within(row(0)).findByRole("button", { name: "false" }));
  await waitFor(() =>
    expect(
      (saved()[0].metadataPatch as { chyron: { visible: boolean } }).chyron
        .visible,
    ).toBe(true),
  );

  // Back to the scene's own metadata.
  fireEvent.click(
    within(row(0)).getByRole("button", { name: "Reset to scene metadata" }),
  );
  await waitFor(() =>
    expect(saved()[0].metadataPatch).toEqual({
      chyron: { text: "Hello", visible: true },
    }),
  );
});

it("adds and removes components and properties, parsing typed values", async () => {
  await openCues([{ id: "a", kind: "sceneUpdate", sceneId: 6 }]);
  const typeInput = () =>
    within(row(0)).getByPlaceholderText("Component type (e.g. chyron)");
  const addComponent = () =>
    within(row(0)).getAllByRole("button", { name: /Add/ })[0];

  expect(addComponent()).toBeDisabled();
  fireEvent.change(typeInput(), { target: { value: "  " } });
  expect(addComponent()).toBeDisabled();
  fireEvent.change(typeInput(), { target: { value: " ticker " } });
  fireEvent.click(addComponent());
  await waitFor(() => expect(saved()[0].metadataPatch).toEqual({ ticker: {} }));
  expect(await within(row(0)).findByText("ticker")).toBeVisible();
  expect(within(row(0)).getByText("New")).toBeVisible();
  expect(within(row(0)).getByText("No properties yet.")).toBeVisible();
  expect(typeInput()).toHaveValue("");
  // The same component cannot be added twice.
  fireEvent.change(typeInput(), { target: { value: "ticker" } });
  expect(addComponent()).toBeDisabled();

  const propName = () => within(row(0)).getByPlaceholderText("Property name");
  const propValue = () => within(row(0)).getByPlaceholderText("Value");
  const addProp = () =>
    within(row(0)).getAllByRole("button", { name: "Add" }).at(-1)!;
  expect(addProp()).toBeDisabled();
  const values: [string, string, unknown][] = [
    ["speed", "12", 12],
    ["paused", "false", false],
    ["live", "true", true],
    ["owner", "null", null],
    ["items", '["a","b"]', ["a", "b"]],
    ["title", "Breaking news", "Breaking news"],
    ["blank", "   ", ""],
  ];
  for (const [key, raw, expected] of values) {
    fireEvent.change(propName(), { target: { value: key } });
    fireEvent.change(propValue(), { target: { value: raw } });
    fireEvent.click(addProp());
    await waitFor(() =>
      expect(
        (saved()[0].metadataPatch as Record<string, Record<string, unknown>>)
          .ticker[key],
      ).toEqual(expected),
    );
  }
  expect(propName()).toHaveValue("");
  // An existing property cannot be added again.
  fireEvent.change(propName(), { target: { value: "speed" } });
  expect(addProp()).toBeDisabled();
  fireEvent.change(propName(), { target: { value: "   " } });
  expect(addProp()).toBeDisabled();

  // Values show as they were typed: null, lists as JSON, text as itself.
  expect(within(row(0)).getByDisplayValue("null")).toBeVisible();
  expect(within(row(0)).getByDisplayValue('["a","b"]')).toBeVisible();
  expect(within(row(0)).getByDisplayValue("12")).toBeVisible();

  const removeProps = () =>
    within(row(0)).getAllByRole("button", { name: "Remove property" });
  fireEvent.click(removeProps()[0]);
  await waitFor(() =>
    expect(
      (saved()[0].metadataPatch as Record<string, Record<string, unknown>>)
        .ticker.speed,
    ).toBeUndefined(),
  );
  while (removeProps().length > 1) {
    const count = removeProps().length;
    fireEvent.click(removeProps()[0]);
    await waitFor(() => expect(removeProps()).toHaveLength(count - 1));
  }
  // Removing the last property removes the component and the patch.
  fireEvent.click(removeProps()[0]);
  await waitFor(() => expect(saved()[0].metadataPatch).toBeUndefined());

  fireEvent.change(typeInput(), { target: { value: "clock" } });
  fireEvent.click(addComponent());
  await waitFor(() => expect(saved()[0].metadataPatch).toEqual({ clock: {} }));
  fireEvent.click(
    await within(row(0)).findByRole("button", { name: "Remove component" }),
  );
  await waitFor(() => expect(saved()[0].metadataPatch).toBeUndefined());
});

it("edits a component that a saved patch holds as a non-object", async () => {
  await openCues([
    {
      id: "a",
      kind: "sceneUpdate",
      sceneId: 6,
      metadataPatch: { ticker: "legacy", clock: { size: 2 } },
    },
  ]);
  expect(within(row(0)).getByText("Editing effective metadata")).toBeVisible();
  // A non-object component shows no properties; adding one replaces it.
  const cards = within(row(0)).getAllByPlaceholderText("Property name");
  fireEvent.change(cards[0], { target: { value: "speed" } });
  fireEvent.change(within(row(0)).getAllByPlaceholderText("Value")[0], {
    target: { value: "3" },
  });
  fireEvent.click(within(row(0)).getAllByRole("button", { name: "Add" })[1]);
  await waitFor(() =>
    expect(saved()[0].metadataPatch).toEqual({
      ticker: { speed: 3 },
      clock: { size: 2 },
    }),
  );
});

it("removes one property and keeps the other components as saved", async () => {
  await openCues([
    {
      id: "a",
      kind: "sceneUpdate",
      sceneId: 6,
      metadataPatch: { ticker: "legacy", clock: { size: 2, color: "red" } },
    },
  ]);
  fireEvent.click(
    within(row(0)).getAllByRole("button", { name: "Remove property" })[0],
  );
  await waitFor(() =>
    expect(saved()[0].metadataPatch).toEqual({
      ticker: "legacy",
      clock: { color: "red" },
    }),
  );
});

it("ignores a saved patch that is not an object", async () => {
  await openCues([
    {
      id: "a",
      kind: "sceneUpdate",
      sceneId: 3,
      metadataPatch: ["not", "an", "object"] as unknown as Record<
        string,
        unknown
      >,
    },
  ]);
  expect(
    within(row(0)).getByText("Showing current scene metadata"),
  ).toBeVisible();
});
