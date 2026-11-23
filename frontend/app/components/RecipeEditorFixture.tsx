import type { FlightCue, FlightSequence, Scene, SongCatalogItem } from "../models/broadcast";
import type { Recipe } from "../services/recipes";
import RecipeEditor from "./RecipeEditor";

// The `rundown-recipes` visual fixture (gaulatti/alcantara#426): one recipe with two uses, a chosen
// song and its preview with one issue. Fictional names only.
const scene = (id: number, name: string) => ({ id, name }) as Scene;
const scenes = [scene(10, "Artist bumper"), scene(20, "Slideshow"), scene(30, "Studio desk")];
const recipe: Recipe = {
  id: 1,
  name: "Song",
  revision: 4,
  steps: [
    "point-bumper",
    "show-bumper",
    "hold-bumper",
    "play-song",
    "point-slideshow",
    "show-slideshow",
    "hold-for-song",
    "back",
  ],
  returnSceneId: 30,
  bumperSceneId: 10,
  slideshowSceneId: 20,
  transitionId: "crescendo-prism",
  holdMs: 3000,
};
const use = (useId: string) =>
  ({ id: `${useId}.show-bumper`, kind: "scene", sceneId: 10, recipeUse: { useId, recipeId: 1, step: "show-bumper" } }) as FlightCue;
const sequence = {
  id: 1,
  name: "Evening",
  items: [use("use_a1b2c3d4e5f6"), use("use_f6e5d4c3b2a1")],
  loop: false,
  isRunning: false,
  activeItemId: null,
  scheduledAt: null,
  publishedAt: null,
  revision: 1,
  lastStartedAt: null,
  createdAt: "",
  updatedAt: "",
} as FlightSequence;
const songs = [
  { id: 1, artist: "North Avenue", title: "Morning signal" },
  { id: 2, artist: "Studio Eight", title: "City lights" },
] as SongCatalogItem[];
const preview = {
  items: [
    { id: "u.1", kind: "sceneUpdate", sceneId: 10 },
    { id: "u.2", kind: "scene", sceneId: 10, transitionId: "crescendo-prism" },
    { id: "u.3", kind: "wait", durationMs: 3000 },
    { id: "u.4", kind: "playSong", songId: 1 },
    { id: "u.5", kind: "sceneUpdate", sceneId: 20 },
    { id: "u.6", kind: "scene", sceneId: 20, transitionId: "crescendo-prism" },
    { id: "u.7", kind: "waitForSongEnd" },
    { id: "u.8", kind: "scene", sceneId: 30, transitionId: "cut" },
  ] as FlightCue[],
  issues: [{ code: "artist_label_missing", message: "North Avenue has no artist label yet." }],
};

export function RecipeEditorFixture() {
  return (
    <main data-visual-fixture="rundown-recipes" className="broadcast-console bg-dark-sand text-text-primary">
      <h1 className="p-6 pb-0 text-3xl font-semibold">Rundown</h1>
      <RecipeEditor
        programId="tv-demo"
        canManage
        fixture={{ recipes: [recipe], sequences: [sequence], scenes, songs, songId: "1", preview }}
      />
    </main>
  );
}
