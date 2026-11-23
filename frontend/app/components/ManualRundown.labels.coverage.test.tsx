import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ManualRundown from "./ManualRundown";
import type { FlightCue, FlightSequence } from "../models/broadcast";
import { fetchFlightSequences, updateFlightSequence } from "../services/flight";
import { expandRecipe, fetchRecipes } from "../services/recipes";
import { fetchAllMediaLabels } from "../services/mediaLabels";
import { rundown, song, stubDialog, stubLibrary } from "../../test/manualRundownKit";

// gaulatti/alcantara#404 (group B, cluster E): a recipe use whose song is not in the library is named by its id, a
// use rebuilt with no media label is rebuilt without one, and a rebuild the service refuses is reported.

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
  vi.mocked(updateFlightSequence).mockImplementation(async (_program, id, body) => {
    const current = store.find((sequence) => sequence.id === id)!;
    const updated = { ...current, ...body, revision: current.revision + 1 };
    store = store.map((sequence) => (sequence.id === id ? updated : sequence));
    return updated;
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function open(songs: ReturnType<typeof song>[], labelId: string | null = "label-1") {
  store = [rundown(1, "Main show", [...use("use_ffffffffffff", 1, labelId)])];
  stubLibrary({
    state: { activeFlightSequenceId: 1, scenes: [] },
    songs: { data: songs },
    instants: [],
  });
  render(<ManualRundown />);
  await screen.findByText("Cue 0 of 3");
}

it("names a use's song by its id when the library does not list the song", async () => {
  await open([song(2, "Second Tide", "The Pilots")]);
  expect(screen.getByRole("region", { name: "Song: Song 1 · Song" })).toBeInTheDocument();
});

it("rebuilds a use with no media label when none is chosen", async () => {
  vi.mocked(expandRecipe).mockResolvedValue({ items: use("use_ffffffffffff"), issues: [] });
  await open([song(1, "Harbor Light", "The Lighthouse Keepers")], null);
  fireEvent.click(within(screen.getByRole("region", { name: "Song: Harbor Light · Song" })).getByRole("button", { name: "Change the label" }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Media label" })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Rebuild the use" }));
  await waitFor(() => expect(expandRecipe).toHaveBeenCalledWith("main", 7, { songId: 1, labelId: null }, "use_ffffffffffff"));
});

it("reports a label rebuild the service refuses", async () => {
  vi.mocked(expandRecipe).mockRejectedValue(new Error("Label service down"));
  await open([song(1, "Harbor Light", "The Lighthouse Keepers")]);
  fireEvent.click(within(screen.getByRole("region", { name: "Song: Harbor Light · Song" })).getByRole("button", { name: "Change the label" }));
  fireEvent.click(await screen.findByRole("button", { name: "Rebuild the use" }));
  expect(await screen.findByText("Label service down")).toBeInTheDocument();
});
