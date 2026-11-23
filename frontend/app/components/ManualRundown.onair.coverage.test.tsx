import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ManualRundown from "./ManualRundown";
import type { FlightCue, FlightSequence } from "../models/broadcast";
import { fetchFlightSequences } from "../services/flight";
import { fetchRecipes } from "../services/recipes";
import { fetchAllMediaLabels } from "../services/mediaLabels";
import { instant, rundown, song, stubDialog, stubLibrary } from "../../test/manualRundownKit";

// gaulatti/alcantara#404 (group B, cluster B): a recipe use's row and its steps as the operator sees them while
// the rundown runs. The active cue is read from the sequence payload (isRunning and activeItemId): inside the
// use, the use is on air; past it, the use is played.

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
const use = (useId: string): FlightCue[] =>
  (["bumper", "song", "songEnd"] as const).map((step) => ({
    id: `${useId}.${step}`,
    kind: step === "bumper" ? "scene" : step === "song" ? "playSong" : "waitForSongEnd",
    ...(step === "bumper" ? { sceneId: 3, transitionId: "cut" } : {}),
    ...(step === "song" ? { songId: 1 } : {}),
    recipeUse: { useId, recipeId: 7, recipeRevision: 1, step, params: { songId: 1, labelId: null } },
  })) as FlightCue[];
const plain = (id: string): FlightCue => ({ id, kind: "wait", durationMs: 1000 });

let store: FlightSequence[] = [];

beforeEach(() => {
  stubDialog();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(fetchRecipes).mockResolvedValue([RECIPE] as never);
  vi.mocked(fetchAllMediaLabels).mockResolvedValue([] as never);
  vi.mocked(fetchFlightSequences).mockImplementation(async () => store);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A running rundown: [plain a, the use u (3 cues), plain z]. The active cue is `activeItemId`. */
async function openRunning(activeItemId: string) {
  store = [
    {
      ...rundown(1, "Main show", [plain("a"), ...use("use_uuuuuuuuuuuu"), plain("z")]),
      isRunning: true,
      activeItemId,
    } as FlightSequence,
  ];
  stubLibrary({
    state: { activeFlightSequenceId: 1, scenes: [] },
    songs: { data: [song(1, "Harbor Light", "The Lighthouse Keepers")] },
    instants: [instant(5, "Applause")],
  });
  render(<ManualRundown />);
  await screen.findByText("Runtime");
}

it("marks a recipe use on air while the cue inside it is playing, and shows its active step", async () => {
  await openRunning("use_uuuuuuuuuuuu.song");
  const row = screen.getByRole("region", { name: /Song: Harbor Light · Song/ });
  expect(row).toHaveClass("bg-sea/10");
  expect(within(row).getByText("On air")).toBeInTheDocument();
  fireEvent.click(within(row).getByRole("button", { name: "Show the steps" }));
  const steps = within(row).getByRole("list", { name: "Steps" }).querySelectorAll("li");
  expect(steps[1]).toHaveAttribute("aria-current", "step");
  expect(steps[0]).not.toHaveAttribute("aria-current");
});

it("shows a recipe use that has already played as played, with no on-air mark", async () => {
  await openRunning("z");
  const row = screen.getByRole("region", { name: /Song: Harbor Light · Song/ });
  expect(row).toHaveClass("opacity-60");
  expect(within(row).queryByText("On air")).toBeNull();
});
