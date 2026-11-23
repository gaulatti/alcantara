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
import { expandRecipe, fetchRecipes } from "../services/recipes";
import { fetchAllMediaLabels } from "../services/mediaLabels";
import { instant, rundown, song, stubDialog, stubLibrary } from "../../test/manualRundownKit";

// gaulatti/alcantara#425 (#222 R4): recipe uses in the operator rundown. A use is added from the
// library's Recipes tab, shows as one row, opens to its steps, moves as a whole, and can be
// detached, relabelled or removed. Every change is saved through the rundown's normal update.
vi.setConfig({ testTimeout: 30_000 });

vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: true, error: null }) }));
vi.mock("../utils/globalProgram", () => ({ useGlobalProgramId: () => ["main"] }));
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
vi.mock("../services/recipes", () => ({ fetchRecipes: vi.fn(), expandRecipe: vi.fn() }));
vi.mock("../services/mediaLabels", () => ({ fetchAllMediaLabels: vi.fn() }));
vi.mock("@gaulatti/bleecker", async (original) => {
  const kit = await import("../../test/manualRundownKit");
  return kit.nativeSelect(original as () => Promise<typeof import("@gaulatti/bleecker")>);
});

const RECIPE = {
  id: 7,
  name: "Song",
  revision: 1,
  steps: ["bumper", "song", "songEnd"],
  returnSceneId: null,
  bumperSceneId: 3,
  slideshowSceneId: null,
  transitionId: "cut",
  holdMs: 0,
};
const use = (useId: string, songId = 1, labelId: string | null = null): FlightCue[] =>
  (["bumper", "song", "songEnd"] as const).map((step) => ({
    id: `${useId}.${step}`,
    kind: step === "bumper" ? "scene" : step === "song" ? "playSong" : "waitForSongEnd",
    ...(step === "bumper" ? { sceneId: 3, transitionId: "cut" } : {}),
    ...(step === "song" ? { songId } : {}),
    recipeUse: { useId, recipeId: 7, recipeRevision: 1, step, params: { songId, labelId } },
  }));
const plain = (id: string): FlightCue => ({ id, kind: "wait", durationMs: 1000 });

let store: FlightSequence[] = [];
const saved = () => store[0].items;
const ids = (items: FlightCue[]) => items.map((item) => item.id);

beforeEach(() => {
  stubDialog();
  vi.mocked(fetchFlightSequences).mockImplementation(async () => store);
  vi.mocked(updateFlightSequence).mockImplementation(async (_program, id, body) => {
    const current = store.find((sequence) => sequence.id === id)!;
    const updated = { ...current, ...body, revision: current.revision + 1 };
    store = store.map((sequence) => (sequence.id === id ? updated : sequence));
    return updated;
  });
  vi.mocked(fetchRecipes).mockResolvedValue([RECIPE]);
  vi.mocked(fetchAllMediaLabels).mockResolvedValue([{ id: "label-1", name: "Fictional stills" }] as never);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function waitFor(check: () => void) {
  await settleWaitFor(check);
  await act(async () => {});
}

async function open(items: FlightCue[]) {
  store = [rundown(1, "Main show", items)];
  stubLibrary({
    state: { activeFlightSequenceId: 1, scenes: [] },
    songs: { data: [song(1, "Harbor Light", "The Lighthouse Keepers"), song(2, "Second Tide", "The Pilots")] },
    instants: [instant(5, "Applause")],
  });
  render(<ManualRundown />);
  await screen.findByText(`Cue 0 of ${items.length}`);
}

async function addWithRecipe(title: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Recipes" }));
  const option = screen.getByRole("option", { name: new RegExp(title) });
  fireEvent.click(option);
  fireEvent.keyDown(screen.getByRole("listbox", { name: "Library items" }), { key: "Enter" });
}

const useRow = (title: string) => screen.getByRole("region", { name: `Song: ${title} · Song` });

it("adds a song with a recipe as one use, in one save, and shows it as one row", async () => {
  vi.mocked(expandRecipe).mockResolvedValue({ items: use("use_aaaaaaaaaaaa"), issues: [] });
  await open([plain("a")]);
  await addWithRecipe("Harbor Light");
  await waitFor(() => expect(ids(saved())).toEqual(["a", ...ids(use("use_aaaaaaaaaaaa"))]));
  expect(expandRecipe).toHaveBeenCalledWith("main", 7, { songId: 1 });
  expect(updateFlightSequence).toHaveBeenCalledTimes(1);
  const row = useRow("Harbor Light");
  expect(row).toHaveTextContent("3 steps");
  expect(within(row).queryByRole("list", { name: "Steps" })).toBeNull();
  fireEvent.click(within(row).getByRole("button", { name: "Show the steps" }));
  expect(within(within(row).getByRole("list", { name: "Steps" })).getAllByRole("listitem")).toHaveLength(3);
});

it("shows a use's issues before adding it, and adds it only on Add anyway", async () => {
  vi.mocked(expandRecipe).mockResolvedValue({
    items: use("use_bbbbbbbbbbbb"),
    issues: [{ code: "artist_label_missing", message: "No media label for The Lighthouse Keepers" }],
  });
  await open([]);
  await addWithRecipe("Harbor Light");
  const issues = await screen.findByRole("list", { name: "Recipe issues" });
  expect(issues).toHaveTextContent("No media label for The Lighthouse Keepers");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(updateFlightSequence).not.toHaveBeenCalled();
  await addWithRecipe("Harbor Light");
  fireEvent.click(await screen.findByRole("button", { name: "Add anyway" }));
  await waitFor(() => expect(ids(saved())).toEqual(ids(use("use_bbbbbbbbbbbb"))));
});

it("detaches a use: the same cues are saved without their tag and show as ordinary cues", async () => {
  await open([...use("use_cccccccccccc")]);
  fireEvent.click(within(useRow("Harbor Light")).getByRole("button", { name: /Detach/ }));
  await waitFor(() => expect(saved().every((cue) => !cue.recipeUse)).toBe(true));
  expect(ids(saved())).toEqual(ids(use("use_cccccccccccc")));
  expect(screen.queryByRole("region", { name: /Song: Harbor Light/ })).toBeNull();
});

it("moves a whole use past a cue, and removes it", async () => {
  await open([...use("use_dddddddddddd"), plain("z")]);
  fireEvent.click(within(useRow("Harbor Light")).getByRole("button", { name: "Move the use down" }));
  await waitFor(() => expect(ids(saved())).toEqual(["z", ...ids(use("use_dddddddddddd"))]));
  fireEvent.click(within(useRow("Harbor Light")).getByRole("button", { name: "Remove the use" }));
  await waitFor(() => expect(ids(saved())).toEqual(["z"]));
});

it("rebuilds a use in place with another label, keeping its ids", async () => {
  vi.mocked(expandRecipe).mockResolvedValue({ items: use("use_eeeeeeeeeeee", 1, "label-1"), issues: [] });
  await open([plain("a"), ...use("use_eeeeeeeeeeee"), plain("b")]);
  fireEvent.click(within(useRow("Harbor Light")).getByRole("button", { name: "Change the label" }));
  const select = await screen.findByRole("combobox", { name: "Media label" });
  await waitFor(() => expect(within(select).getByRole("option", { name: "Fictional stills" })).toBeTruthy());
  fireEvent.change(select, { target: { value: "label-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Rebuild the use" }));
  await waitFor(() => expect(saved()[1].recipeUse?.params.labelId).toBe("label-1"));
  expect(expandRecipe).toHaveBeenCalledWith("main", 7, { songId: 1, labelId: "label-1" }, "use_eeeeeeeeeeee");
  expect(ids(saved())).toEqual(["a", ...ids(use("use_eeeeeeeeeeee")), "b"]);
});

it("marks a use split by a hand edit as partial, offering detach but not relabel", async () => {
  const [first, ...rest] = use("use_ffffffffffff");
  await open([first, plain("x"), ...rest]);
  const parts = screen.getAllByRole("region", { name: "Song: Harbor Light · Song" });
  expect(parts).toHaveLength(2);
  for (const part of parts) {
    expect(part).toHaveTextContent("Partial use");
    expect(within(part).queryByRole("button", { name: "Change the label" })).toBeNull();
  }
});

it("has no Recipes tab when the API has no recipes, and still adds library songs and clips", async () => {
  vi.mocked(fetchRecipes).mockResolvedValue(null);
  await open([]);
  expect(screen.queryByRole("button", { name: "Recipes" })).toBeNull();
  fireEvent.doubleClick(screen.getByRole("option", { name: /Applause/ }));
  await waitFor(() => expect(saved()).toEqual([expect.objectContaining({ kind: "instant", instantId: 5 })]));
});

it("keeps the rundown working when the recipes cannot be loaded", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(fetchRecipes).mockRejectedValue(new Error("offline"));
  await open([]);
  expect(screen.queryByRole("button", { name: "Recipes" })).toBeNull();
  expect(error).toHaveBeenCalledWith("Failed to load recipes:", expect.any(Error));
});

// gaulatti/alcantara#404 (group B): a recipe that expands to nothing, an expansion the service refuses, and a
// save refused after the operator has accepted a use's issues.

it("says a recipe with no steps has nothing to add", async () => {
  vi.mocked(expandRecipe).mockResolvedValue({ items: [], issues: [] });
  await open([plain("a")]);
  await addWithRecipe("Harbor Light");
  expect(await screen.findByText("The recipe has no steps to add.")).toBeInTheDocument();
  expect(updateFlightSequence).not.toHaveBeenCalled();
});

it("shows why a recipe could not be expanded", async () => {
  vi.mocked(expandRecipe).mockRejectedValue(new Error("Recipe service down"));
  await open([plain("a")]);
  await addWithRecipe("Harbor Light");
  expect(await screen.findByText("Recipe service down")).toBeInTheDocument();
  expect(updateFlightSequence).not.toHaveBeenCalled();
});

it("keeps the issues visible when the save refuses the use they were accepted for", async () => {
  vi.mocked(expandRecipe).mockResolvedValue({
    items: use("use_cccccccccccc"),
    issues: [{ code: "artist_label_missing", message: "No media label for The Lighthouse Keepers" }],
  });
  vi.mocked(updateFlightSequence).mockRejectedValueOnce(new Error("Sequence is locked"));
  await open([]);
  await addWithRecipe("Harbor Light");
  fireEvent.click(await screen.findByRole("button", { name: "Add anyway" }));
  expect(await screen.findByText("Sequence is locked")).toBeInTheDocument();
});
