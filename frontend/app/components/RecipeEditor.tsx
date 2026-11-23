import { Button, Empty, Field, Input, Select, StatePill, Switch } from "@gaulatti/bleecker";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FlightCue, FlightSequence, Scene, SongCatalogItem } from "../models/broadcast";
import {
  RecipeConflictError,
  expandRecipe,
  fetchRecipes,
  updateRecipe,
  type Recipe,
  type RecipeExpansion,
} from "../services/recipes";
import { fetchFlightSequences } from "../services/flight";
import { apiUrl } from "../utils/apiBaseUrl";
import { TRANSITION_OPTIONS } from "../utils/transitionOptions";

/**
 * The steps of the song recipe, in order (the design note of gaulatti/alcantara#222). A recipe's
 * `steps` lists the keys it runs (the backend stores them in airing order and refuses an unknown key); a
 * step left out is skipped. A key this list does not know is shown
 * as it came, so a step the backend adds is not lost on save.
 */
export const RECIPE_STEPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "bumperPoint", label: "Point the artist bumper at the song" },
  { key: "bumper", label: "Show the bumper" },
  { key: "hold", label: "Hold the bumper" },
  { key: "song", label: "Play the song" },
  { key: "slideshowPoint", label: "Point the slideshow at the artist's label" },
  { key: "slideshow", label: "Show the slideshow" },
  { key: "songEnd", label: "Hold for the song" },
  { key: "back", label: "Go back to the return scene" },
];

export interface RecipeEditorFixture {
  recipes: Recipe[];
  sequences: FlightSequence[];
  scenes: Scene[];
  songs: SongCatalogItem[];
  /** The song chosen for the preview, and the preview shown. */
  songId?: string;
  preview?: RecipeExpansion;
}

const NO_SCENE = "";
const MAX_HOLD_SECONDS = 60;

interface TaggedCue {
  recipeUse?: { useId?: string; recipeId?: number };
}

const useOf = (cue: FlightCue) => (cue as FlightCue & TaggedCue).recipeUse;

/** The uses of a recipe in the program's sequences: each use id with its cues, in order. */
export function usesOfRecipe(
  sequences: readonly FlightSequence[],
  recipeId: number,
): Array<{ useId: string; sequence: FlightSequence; cues: FlightCue[] }> {
  const uses: Array<{ useId: string; sequence: FlightSequence; cues: FlightCue[] }> = [];
  for (const sequence of sequences) {
    const byUse = new Map<string, FlightCue[]>();
    for (const cue of sequence.items) {
      const tag = useOf(cue);
      if (tag?.recipeId !== recipeId || !tag.useId) continue;
      byUse.set(tag.useId, [...(byUse.get(tag.useId) ?? []), cue]);
    }
    for (const [useId, cues] of byUse) uses.push({ useId, sequence, cues });
  }
  return uses;
}

/**
 * The uses a save will rebuild: those in a sequence that is not running, and those in a running one
 * whose cues all come after the cue on air.
 */
export function usesNotYetAired(
  sequences: readonly FlightSequence[],
  recipeId: number,
): number {
  return usesOfRecipe(sequences, recipeId).filter(({ sequence, cues }) => {
    if (!sequence.isRunning) return true;
    const active = sequence.items.findIndex((cue) => cue.id === sequence.activeItemId);
    return sequence.items.indexOf(cues[0]) > active;
  }).length;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function stepRows(recipe: Recipe): Array<{ key: string; label: string; enabled: boolean }> {
  const known = new Set(RECIPE_STEPS.map((step) => step.key));
  const unknown = recipe.steps.filter((key) => !known.has(key));
  return [
    ...RECIPE_STEPS.map((step) => ({ ...step, enabled: recipe.steps.includes(step.key) })),
    ...unknown.map((key) => ({ key, label: key, enabled: true })),
  ];
}

export function describeCue(cue: FlightCue, scenes: readonly Scene[]): string {
  const sceneName = (id: number | undefined) =>
    scenes.find((scene) => scene.id === id)?.name ?? `scene ${id ?? "?"}`;
  switch (cue.kind) {
    case "sceneUpdate":
      return `Point ${sceneName(cue.sceneId)} at the song`;
    case "scene":
      return `Show ${sceneName(cue.sceneId)} (${cue.transitionId ?? "cut"})`;
    case "wait":
      return `Hold for ${((cue.durationMs ?? 0) / 1000).toString()} s`;
    case "playSong":
      return "Play the song";
    case "waitForSongEnd":
      return "Wait for the song to end";
    default:
      return cue.label ?? cue.kind;
  }
}

/**
 * A program's recipes (gaulatti/alcantara#426, contract C3 of #222, at `/program/:programId/recipes`): the list with how many uses each
 * has, and a form for the scenes, transition, hold and steps, with a preview of what a use would be.
 * Read-only without `flight.manage`; an empty state while the backend answers 404.
 */
export function RecipeEditor({
  programId,
  canManage,
  fixture,
}: {
  programId: string;
  canManage: boolean;
  /** Fixed data for the visual fixture `rundown-recipes`: nothing is fetched. */
  fixture?: RecipeEditorFixture;
}) {
  const [recipes, setRecipes] = useState<Recipe[] | null | undefined>(fixture?.recipes);
  const [sequences, setSequences] = useState<FlightSequence[]>(fixture?.sequences ?? []);
  const [scenes, setScenes] = useState<Scene[]>(fixture?.scenes ?? []);
  const [songs, setSongs] = useState<SongCatalogItem[]>(fixture?.songs ?? []);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(fixture?.recipes[0]?.id ?? null);
  const [draft, setDraft] = useState<Recipe | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [songId, setSongId] = useState(fixture?.songId ?? "");
  const [preview, setPreview] = useState<RecipeExpansion | null>(fixture?.preview ?? null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setConflict(false);
    try {
      const [loadedRecipes, loadedSequences, state, songPage] = await Promise.all([
        fetchRecipes(programId),
        fetchFlightSequences(programId),
        fetch(apiUrl(`/program/${encodeURIComponent(programId)}/state`)).then((response) =>
          response.ok ? response.json() : null,
        ),
        fetch(apiUrl("/songs?page=1&limit=1000")).then((response) =>
          response.ok ? response.json() : null,
        ),
      ]);
      setRecipes(loadedRecipes);
      setSequences(loadedSequences.filter((sequence) => !sequence.scheduledAt));
      const entries: Array<{ scene?: Scene }> = Array.isArray(state?.scenes) ? state.scenes : [];
      setScenes(entries.flatMap((entry) => (entry.scene ? [entry.scene] : [])));
      setSongs(Array.isArray(songPage?.data) ? songPage.data : []);
      setSelectedId((current) => current ?? loadedRecipes?.[0]?.id ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [programId]);

  useEffect(() => {
    if (!fixture) void load();
  }, [load, fixture]);

  const selected = recipes?.find((recipe) => recipe.id === selectedId) ?? null;
  // A new object for the same recipe (after a save or a reload) replaces the draft; a different recipe
  // also clears what belonged to the previous one.
  useEffect(() => {
    setDraft(selected);
  }, [selected]);
  useEffect(() => {
    setConfirming(false);
    setConflict(false);
    setNotice(null);
    setPreview(fixture?.preview ?? null);
    setPreviewError(null);
  }, [selectedId, fixture]);

  const sceneOptions = useMemo(
    () => [
      { value: NO_SCENE, label: "No scene (step skipped)" },
      ...scenes.map((scene) => ({ value: String(scene.id), label: scene.name })),
    ],
    [scenes],
  );
  const songOptions = useMemo(
    () => [
      { value: "", label: "Choose a song" },
      ...songs.map((song) => ({ value: String(song.id), label: `${song.artist} - ${song.title}` })),
    ],
    [songs],
  );

  if (error) {
    return (
      <div className="p-6">
        <Empty
          title="Recipes could not be loaded"
          description={error}
          action={
            <Button variant="secondary" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }
  if (recipes === undefined) return <p className="p-6 text-sm text-text-secondary">Loading recipes…</p>;
  if (recipes === null) {
    return (
      <div className="p-6">
        <Empty
          title="Recipes are not available yet"
          description="This backend does not offer rundown recipes. Nothing here changes until it does."
        />
      </div>
    );
  }
  if (recipes.length === 0) {
    return (
      <div className="p-6">
        <Empty
          title="No recipes in this show yet"
          description="A recipe is the steps a song needs around it: bumper, transition, hold, slideshow and back. Ask for the starter Song recipe on this show."
        />
      </div>
    );
  }

  const dirty = draft !== null && selected !== null && JSON.stringify(draft) !== JSON.stringify(selected);
  const toRebuild = selected ? usesNotYetAired(sequences, selected.id) : 0;
  // Only the form's inputs call this, and they exist only while a draft does.
  const patch = (changes: Partial<Recipe>) => setDraft((current) => ({ ...current!, ...changes }));
  const sceneValue = (id: number | null) => (id === null ? NO_SCENE : String(id));
  const sceneId = (value: string) => (value === NO_SCENE ? null : Number(value));

  const save = async (recipeDraft: Recipe) => {
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const { recipe: saved, rebuilt } = await updateRecipe(programId, recipeDraft);
      setRecipes((current) => current!.map((recipe) => (recipe.id === saved.id ? saved : recipe)));
      setConfirming(false);
      // The count is the backend's: how many uses it rebuilt from the saved recipe.
      setNotice(
        rebuilt === 0
          ? "Recipe saved. No upcoming use needed a rebuild."
          : `Recipe saved. ${plural(rebuilt, "upcoming use")} ${rebuilt === 1 ? "was" : "were"} rebuilt from it.`,
      );
    } catch (saveError) {
      if (saveError instanceof RecipeConflictError) {
        setConflict(true);
        setConfirming(false);
      } else {
        setNotice(saveError instanceof Error ? saveError.message : String(saveError));
      }
    } finally {
      setSaving(false);
    }
  };

  // The Preview button is disabled until a song is chosen.
  const runPreview = async (recipeId: number) => {
    setPreviewError(null);
    try {
      setPreview(await expandRecipe(programId, recipeId, { songId: Number(songId) }));
    } catch (previewFailure) {
      setPreview(null);
      setPreviewError(previewFailure instanceof Error ? previewFailure.message : String(previewFailure));
    }
  };

  return (
    <div className="grid gap-6 p-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <ul className="space-y-2" aria-label="Recipes">
        {recipes.map((recipe) => (
          <li key={recipe.id}>
            <button
              type="button"
              aria-pressed={recipe.id === selectedId}
              onClick={() => setSelectedId(recipe.id)}
              className="w-full rounded-lg border border-border-subtle px-4 py-3 text-left text-sm aria-pressed:border-accent-blue aria-pressed:bg-accent-blue/15"
            >
              <span className="block font-semibold text-text-primary">{recipe.name}</span>
              <span className="block text-xs text-text-secondary">
                Revision {recipe.revision} · {plural(usesOfRecipe(sequences, recipe.id).length, "use")}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {draft && selected ? (
        <section className="space-y-5" aria-label={`Recipe ${selected.name}`}>
          {!canManage ? <StatePill tone="idle" label="Read only: you cannot change recipes" /> : null}
          {conflict ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-terracotta/40 p-3 text-sm text-terracotta">
              Changed elsewhere. Reload this recipe, then make your change again.
              <Button
                variant="secondary"
                onClick={() => {
                  setRecipes(undefined);
                  void load();
                }}
              >
                Reload
              </Button>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input value={draft.name} disabled={!canManage} onChange={(event) => patch({ name: event.target.value })} />
            </Field>
            <Field label="Transition">
              <Select
                aria-label="Transition"
                value={draft.transitionId}
                disabled={!canManage}
                onChange={(value) => patch({ transitionId: value })}
                options={TRANSITION_OPTIONS}
              />
            </Field>
            <Field label="Bumper scene">
              <Select
                aria-label="Bumper scene"
                value={sceneValue(draft.bumperSceneId)}
                disabled={!canManage}
                onChange={(value) => patch({ bumperSceneId: sceneId(value) })}
                options={sceneOptions}
              />
            </Field>
            <Field label="Slideshow scene">
              <Select
                aria-label="Slideshow scene"
                value={sceneValue(draft.slideshowSceneId)}
                disabled={!canManage}
                onChange={(value) => patch({ slideshowSceneId: sceneId(value) })}
                options={sceneOptions}
              />
            </Field>
            <Field label="Return scene">
              <Select
                aria-label="Return scene"
                value={sceneValue(draft.returnSceneId)}
                disabled={!canManage}
                onChange={(value) => patch({ returnSceneId: sceneId(value) })}
                options={sceneOptions}
              />
            </Field>
            <Field label="Hold the bumper (seconds)">
              <Input
                type="number"
                min={0}
                max={MAX_HOLD_SECONDS}
                step={0.5}
                value={draft.holdMs / 1000}
                disabled={!canManage}
                onChange={(event) => {
                  const seconds = Math.min(MAX_HOLD_SECONDS, Math.max(0, event.target.valueAsNumber || 0));
                  patch({ holdMs: Math.round(seconds * 2) * 500 });
                }}
              />
            </Field>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-text-primary">Steps</legend>
            <ol className="space-y-2">
              {stepRows(draft).map((step) => (
                <li key={step.key}>
                  <Switch
                    checked={step.enabled}
                    disabled={!canManage}
                    label={step.label}
                    onCheckedChange={(checked) =>
                      patch({
                        steps: stepRows(draft)
                          .filter((row) => (row.key === step.key ? checked : row.enabled))
                          .map((row) => row.key),
                      })
                    }
                  />
                </li>
              ))}
            </ol>
          </fieldset>

          {canManage ? (
            <div className="space-y-3">
              {confirming ? (
                <div role="status" className="space-y-2 rounded-lg border border-sand/40 p-3 text-sm">
                  <p>
                    {toRebuild === 0
                      ? "No use that has not aired yet follows this recipe, so nothing in the rundown changes."
                      : `${plural(toRebuild, "use")} that ${toRebuild === 1 ? "has" : "have"} not aired yet will be rebuilt from this recipe, including any hand edits to them.`}
                  </p>
                  <div className="flex gap-2">
                    <Button disabled={saving} onClick={() => void save(draft)}>
                      {saving ? "Saving…" : "Confirm save"}
                    </Button>
                    <Button variant="secondary" disabled={saving} onClick={() => setConfirming(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button disabled={!dirty || conflict} onClick={() => setConfirming(true)}>
                  Save recipe
                </Button>
              )}
              {notice ? (
                <p role="status" className="text-xs text-text-secondary">
                  {notice}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-3 border-t border-border-subtle pt-4">
            <p className="text-sm font-semibold text-text-primary">Preview a use</p>
            <p className="text-xs text-text-secondary">Shows the steps for a song with the saved recipe. Nothing is written.</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="flex-1">
                <Select aria-label="Song to preview" value={songId} onChange={setSongId} options={songOptions} />
              </div>
              <Button variant="secondary" disabled={!songId} onClick={() => void runPreview(selected.id)}>
                Preview
              </Button>
            </div>
            {previewError ? (
              <p role="alert" className="text-xs text-terracotta">
                {previewError}
              </p>
            ) : null}
            {preview ? (
              <div className="space-y-2">
                <ol aria-label="Preview steps" className="list-decimal space-y-1 pl-5 text-sm">
                  {preview.items.map((cue) => (
                    <li key={cue.id}>{describeCue(cue, scenes)}</li>
                  ))}
                </ol>
                {preview.issues.length === 0 ? (
                  <p className="text-xs text-text-secondary">No issues.</p>
                ) : (
                  <ul aria-label="Issues" className="space-y-1 text-xs text-terracotta">
                    {preview.issues.map((issue) => (
                      <li key={`${issue.code}:${issue.message}`}>
                        <code>{issue.code}</code> {issue.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export default RecipeEditor;
