import { Card } from "@gaulatti/bleecker";
import type { FlightCue, InstantItem, SongCatalogItem } from "../models/broadcast";
import { getFlightCueDisplayLabel } from "../utils/programFlightSequence";
import { groupRundown } from "../utils/recipeUses";
import { UseRow } from "./ManualRundown";
import { RundownLibrary } from "./RundownLibrary";

// The `rundown-recipe` visual fixture (gaulatti/alcantara#425): an operator rundown holding two
// recipe uses (one on air, its steps open), a use split by a hand-placed cue, and a detached use
// shown as ordinary cues, beside the library with its Recipes tab. Fictional names only.
const song = (id: number, title: string, artist: string): SongCatalogItem => ({
  id,
  title,
  artist,
  durationMs: 214_000,
  audioUrl: `https://media.example.test/${id}.mp3`,
  coverUrl: null,
  earoneSongId: null,
  earoneRank: null,
  earoneSpins: null,
  enabled: true,
});
const songs = [
  song(1, "Harbor Light", "The Lighthouse Keepers"),
  song(2, "Second Tide", "The Pilots"),
  song(3, "Paper Lanterns", "North Quay"),
];
const clips: InstantItem[] = [
  { id: 5, name: "Applause", audioUrl: "https://media.example.test/a.mp3", volume: 1, enabled: true, position: 1 },
];
const STEPS = ["bumperPoint", "bumper", "hold", "song", "slideshowPoint", "slideshow", "songEnd", "back"] as const;
const use = (useId: string, songId: number, steps: readonly string[] = STEPS, tagged = true): FlightCue[] =>
  steps.map((step) => ({
    id: `${useId}.${step}`,
    kind:
      step === "bumperPoint" || step === "slideshowPoint"
        ? "sceneUpdate"
        : step === "hold"
          ? "wait"
          : step === "song"
            ? "playSong"
            : step === "songEnd"
              ? "waitForSongEnd"
              : "scene",
    ...(step === "hold" ? { durationMs: 3000 } : {}),
    ...(step === "song" ? { songId } : {}),
    ...(["bumper", "bumperPoint"].includes(step) ? { sceneId: 10 } : {}),
    ...(["slideshow", "slideshowPoint"].includes(step) ? { sceneId: 20 } : {}),
    ...(step === "back" ? { sceneId: 30 } : {}),
    ...(tagged ? { recipeUse: { useId, recipeId: 1, recipeRevision: 4, step, params: { songId, labelId: null } } } : {}),
  }));
const split = use("use_c3c3c3c3c3c3", 3);
const items: FlightCue[] = [
  ...use("use_a1a1a1a1a1a1", 1),
  ...use("use_b2b2b2b2b2b2", 2),
  ...split.slice(0, 4),
  { id: "hand-wait", kind: "wait", durationMs: 5000, label: "Hand-placed hold" },
  ...split.slice(4),
  ...use("use_d4d4d4d4d4d4", 1, ["bumper", "song", "songEnd"], false),
];
const ON_AIR = 3; // the first use's song
// Every song id the fixture uses is in this table, so a missing id fails loudly instead of showing a placeholder.
const SONG_BY_ID: Record<number, SongCatalogItem> = Object.fromEntries(songs.map((item) => [item.id, item]));

export function RundownRecipeFixture() {
  const rows = groupRundown(items);
  return (
    <main className="console-shell min-h-screen p-6" aria-label="Rundown recipe fixture">
      <h1 className="mb-4 text-lg font-semibold text-zinc-100">Operator rundown with recipe uses</h1>
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <Card className="divide-y divide-zinc-800">
          {rows.map((row, rowIndex) =>
            row.kind === "use" ? (
              <UseRow
                key={`${row.useId}-${row.start}`}
                row={row}
                recipeName="Song"
                songTitle={SONG_BY_ID[row.songId].title}
                rowIndex={rowIndex}
                rowCount={rows.length}
                activeCueIndex={ON_AIR}
                describe={getFlightCueDisplayLabel}
                defaultOpen={rowIndex === 0}
                onMove={() => undefined}
                onDetach={() => undefined}
                onRemove={() => undefined}
                onChangeLabel={() => undefined}
              />
            ) : (
              <p key={row.cue.id} className="px-4 py-3 text-sm text-zinc-300">
                {row.index + 1}. {getFlightCueDisplayLabel(row.cue)}
              </p>
            ),
          )}
        </Card>
        <RundownLibrary
          songs={songs}
          clips={clips}
          disabled={false}
          onAdd={() => undefined}
          recipes={[{ id: 1, name: "Song" }]}
          onAddRecipe={() => undefined}
          footnote="Select an item and press Enter, or double-click it, to add it at the end."
        />
      </div>
    </main>
  );
}
