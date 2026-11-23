import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ManualRundown from "./ManualRundown";
import type { FlightCue, FlightSequence } from "../models/broadcast";
import { deactivateFlightSequence, fetchFlightSequences, updateFlightSequence } from "../services/flight";
import { expandRecipe, fetchRecipes } from "../services/recipes";
import { fetchAllMediaLabels } from "../services/mediaLabels";
import { rundown, song, stubDialog, stubLibrary } from "../../test/manualRundownKit";

// gaulatti/alcantara#404 (group B, cluster A): a recipe use accepted, or a label rebuild confirmed, after its
// rundown was deactivated saves nothing. The dialogs are top-level, so they stay open over a deactivation.

vi.mock("../services/flight", () => ({
  fetchFlightSequences: vi.fn(),
  updateFlightSequence: vi.fn(),
  createFlightSequence: vi.fn(),
  deleteFlightSequence: vi.fn(),
  activateFlightSequence: vi.fn(),
  deactivateFlightSequence: vi.fn(),
  startFlight: vi.fn(),
  stopFlight: vi.fn(),
  goFlight: vi.fn(),
  fetchFlightRuntime: vi.fn(),
}));
vi.mock("../services/recipes", () => ({ fetchRecipes: vi.fn(), expandRecipe: vi.fn() }));
vi.mock("../services/mediaLabels", () => ({ fetchAllMediaLabels: vi.fn() }));
vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: false }) }));
vi.mock("../utils/globalProgram", () => ({ useGlobalProgramId: () => ["main"] }));
vi.mock("@gaulatti/bleecker", async (original) => {
  const kit = await import("../../test/manualRundownKit");
  return kit.nativeSelect(original as () => Promise<typeof import("@gaulatti/bleecker")>);
});

const RECIPE = {
  id: 7, name: "Song", revision: 1, steps: ["bumper", "song", "songEnd"],
  returnSceneId: null, bumperSceneId: 3, slideshowSceneId: null, transitionId: "cut", holdMs: 0,
};
const use = (useId: string, songId = 1, labelId: string | null = null): FlightCue[] =>
  (["bumper", "song", "songEnd"] as const).map((step) => ({
    id: `${useId}.${step}`,
    kind: step === "bumper" ? "scene" : step === "song" ? "playSong" : "waitForSongEnd",
    ...(step === "bumper" ? { sceneId: 3, transitionId: "cut" } : {}),
    ...(step === "song" ? { songId } : {}),
    recipeUse: { useId, recipeId: 7, recipeRevision: 1, step, params: { songId, labelId } },
  })) as FlightCue[];

let store: FlightSequence[] = [];

beforeEach(() => {
  stubDialog();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(fetchRecipes).mockResolvedValue([RECIPE] as never);
  vi.mocked(fetchAllMediaLabels).mockResolvedValue([{ id: "label-1", name: "Fictional stills" }] as never);
  vi.mocked(fetchFlightSequences).mockImplementation(async () => store);
  vi.mocked(deactivateFlightSequence).mockResolvedValue(undefined as never);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function open(items: FlightCue[]) {
  store = [rundown(1, "Main show", items)];
  stubLibrary({
    state: { activeFlightSequenceId: 1, scenes: [] },
    songs: { data: [song(1, "Harbor Light", "The Lighthouse Keepers")] },
    instants: [],
  });
  render(<ManualRundown />);
  await screen.findByText(`Cue 0 of ${items.length}`);
}

async function addWithRecipe(title: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Recipes" }));
  fireEvent.click(screen.getByRole("option", { name: new RegExp(title) }));
  fireEvent.keyDown(screen.getByRole("listbox", { name: "Library items" }), { key: "Enter" });
}

/** The rundown is deactivated from the chooser while a dialog is still open over it. */
async function deactivate() {
  fireEvent.change(screen.getByDisplayValue(/Main show/), { target: { value: "" } });
  expect(await screen.findByText("Sequence deactivated.")).toBeInTheDocument();
}

it("does not save a recipe use accepted after its rundown was deactivated", async () => {
  vi.mocked(expandRecipe).mockResolvedValue({
    items: use("use_gggggggggggg"),
    issues: [{ code: "artist_label_missing", message: "No media label for The Lighthouse Keepers" }],
  });
  await open([]);
  await addWithRecipe("Harbor Light");
  await screen.findByRole("list", { name: "Recipe issues" });
  await deactivate();
  fireEvent.click(screen.getByRole("button", { name: "Add anyway" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(updateFlightSequence).not.toHaveBeenCalled();
});

it("does not rebuild a use's label after its rundown was deactivated", async () => {
  vi.mocked(expandRecipe).mockResolvedValue({ items: use("use_hhhhhhhhhhhh", 1, "label-1"), issues: [] });
  await open(use("use_hhhhhhhhhhhh", 1, "label-1"));
  fireEvent.click(screen.getByRole("button", { name: "Change the label" }));
  await screen.findByRole("combobox", { name: "Media label" });
  await deactivate();
  fireEvent.click(screen.getByRole("button", { name: "Rebuild the use" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(expandRecipe).not.toHaveBeenCalled();
  expect(updateFlightSequence).not.toHaveBeenCalled();
});
