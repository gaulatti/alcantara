import { randomBytes } from 'node:crypto';
import type { FlightCue } from './flight.types';

/**
 * gaulatti/alcantara#424 (#222 R3): rundown recipes. A recipe use is written into a
 * rundown as ordinary cues of the eight existing kinds, each tagged with the use it
 * belongs to (contract C1) and given an id derived from the use and the step
 * (contract C2), so a rebuild keeps ids and the engine's bindings to them. Nothing
 * here touches the database: this module turns a recipe, a song and a label into
 * cues, and finds the uses inside a rundown.
 */

/** The song recipe's steps, in the order they air. */
export const RECIPE_STEPS = [
  'bumperPoint',
  'bumper',
  'hold',
  'song',
  'slideshowPoint',
  'slideshow',
  'songEnd',
  'back',
] as const;
export type RecipeStep = (typeof RECIPE_STEPS)[number];

/** The slideshow's scene metadata key (frontend `models/components.ts`). The bumper's key is the first
 * component of the bumper scene's layout, read from the scene (no component name is hard-coded here). */
export const SLIDESHOW_COMPONENT = 'slideshow';

export const MAX_HOLD_MS = 60_000;

/** Contract C1: the tag every cue of one use carries. */
export interface RecipeUseTag {
  useId: string;
  recipeId: number;
  recipeRevision: number;
  step: string;
  params: { songId: number; labelId?: string | null };
}

export type RecipeCue = FlightCue & { recipeUse: RecipeUseTag };

export interface RecipeDefinition {
  id: number;
  revision: number;
  bumperSceneId: number | null;
  slideshowSceneId: number | null;
  returnSceneId: number | null;
  transitionId: string;
  holdMs: number;
  steps: RecipeStep[];
}

/** The first component of a layout's `componentType` list (comma-separated), or null. */
export function firstComponent(
  componentType: string | null | undefined,
): string | null {
  const first = (componentType ?? '')
    .split(',')
    .map((part) => part.trim())
    .find(Boolean);
  return first ?? null;
}

export interface RecipeSong {
  id: number;
  artist: string;
  title: string;
}

const STEP_SET: ReadonlySet<string> = new Set(RECIPE_STEPS);
const USE_ID = /^use_[0-9a-f]{12}$/;

/** The enabled steps, always in airing order, each once. Unknown names are an error. */
export function normalizeRecipeSteps(value: unknown): RecipeStep[] {
  if (value === undefined || value === null) return [...RECIPE_STEPS];
  if (!Array.isArray(value)) throw new Error('steps must be a list');
  for (const step of value)
    if (typeof step !== 'string' || !STEP_SET.has(step))
      throw new Error(`unknown recipe step ${String(step)}`);
  const chosen = new Set(value as string[]);
  return RECIPE_STEPS.filter((step) => chosen.has(step));
}

export function newUseId(
  bytes: (size: number) => Buffer = randomBytes,
): string {
  return `use_${bytes(6).toString('hex')}`;
}

export function isUseId(value: unknown): value is string {
  return typeof value === 'string' && USE_ID.test(value);
}

/** Contract C2. */
export function cueIdFor(useId: string, step: RecipeStep): string {
  return `${useId}.${step}`;
}

/** The steps that change a scene's picture to the song: they need a label to be useful. */
export function stepsUsingLabel(steps: readonly RecipeStep[]): boolean {
  return steps.includes('bumperPoint') || steps.includes('slideshowPoint');
}

/**
 * The cues of one use. A step whose scene is not set on the recipe is left out, and so
 * is a hold of 0 ms: the use still plays the song.
 */
export function expandRecipe(
  recipe: RecipeDefinition,
  song: RecipeSong,
  labelId: string | null,
  useId: string,
  /** The bumper scene's component, whose metadata the bumper step patches; null skips that step. */
  bumperComponent: string | null = null,
): RecipeCue[] {
  const params: RecipeUseTag['params'] = { songId: song.id, labelId };
  const cue = (step: RecipeStep, body: Omit<FlightCue, 'id'>): RecipeCue => ({
    id: cueIdFor(useId, step),
    ...body,
    recipeUse: {
      useId,
      recipeId: recipe.id,
      recipeRevision: recipe.revision,
      step,
      params: { ...params },
    },
  });
  const cues: RecipeCue[] = [];
  for (const step of recipe.steps) {
    switch (step) {
      case 'bumperPoint':
        if (recipe.bumperSceneId !== null && bumperComponent)
          cues.push(
            cue(step, {
              kind: 'sceneUpdate',
              sceneId: recipe.bumperSceneId,
              metadataPatch: {
                [bumperComponent]: {
                  artist: song.artist,
                  songTitle: song.title,
                  labelId,
                },
              },
            }),
          );
        break;
      case 'bumper':
        if (recipe.bumperSceneId !== null)
          cues.push(
            cue(step, {
              kind: 'scene',
              sceneId: recipe.bumperSceneId,
              transitionId: recipe.transitionId,
            }),
          );
        break;
      case 'hold':
        if (recipe.holdMs > 0)
          cues.push(cue(step, { kind: 'wait', durationMs: recipe.holdMs }));
        break;
      case 'song':
        cues.push(cue(step, { kind: 'playSong', songId: song.id }));
        break;
      case 'slideshowPoint':
        if (recipe.slideshowSceneId !== null)
          cues.push(
            cue(step, {
              kind: 'sceneUpdate',
              sceneId: recipe.slideshowSceneId,
              metadataPatch: { [SLIDESHOW_COMPONENT]: { labelId } },
            }),
          );
        break;
      case 'slideshow':
        if (recipe.slideshowSceneId !== null)
          cues.push(
            cue(step, {
              kind: 'scene',
              sceneId: recipe.slideshowSceneId,
              transitionId: recipe.transitionId,
            }),
          );
        break;
      case 'songEnd':
        cues.push(cue(step, { kind: 'waitForSongEnd' }));
        break;
      case 'back':
        if (recipe.returnSceneId !== null)
          cues.push(
            cue(step, {
              kind: 'scene',
              sceneId: recipe.returnSceneId,
              transitionId: recipe.transitionId,
            }),
          );
        break;
    }
  }
  return cues;
}

/** A use found in a rundown: where its cues are and what it was built from. */
export interface FoundUse {
  useId: string;
  recipeId: number;
  recipeRevision: number;
  params: { songId: number; labelId: string | null };
  /** Index of its first cue and one past its last, contiguous. */
  start: number;
  end: number;
}

function readTag(cue: unknown): RecipeUseTag | null {
  if (!cue || typeof cue !== 'object') return null;
  const tag = (cue as { recipeUse?: unknown }).recipeUse;
  if (!tag || typeof tag !== 'object') return null;
  const t = tag as Record<string, unknown>;
  const params = (t.params ?? {}) as Record<string, unknown>;
  const positive = (n: unknown) => Number.isInteger(n) && (n as number) > 0;
  if (
    !isUseId(t.useId) ||
    typeof t.step !== 'string' ||
    !positive(t.recipeId) ||
    !positive(t.recipeRevision) ||
    !positive(params.songId)
  )
    return null;
  return t as unknown as RecipeUseTag;
}

/**
 * The uses in a rundown's raw items. Only contiguous cues with the same use id make a
 * use; a use split by hand-placed cues counts as several parts, and none of them is
 * rebuilt (the operator detaches or repairs it in the console).
 */
export function findRecipeUses(items: readonly unknown[]): FoundUse[] {
  const runs: FoundUse[] = [];
  let index = 0;
  while (index < items.length) {
    const tag = readTag(items[index]);
    if (!tag) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < items.length && readTag(items[end])?.useId === tag.useId)
      end += 1;
    runs.push({
      useId: tag.useId,
      recipeId: tag.recipeId,
      recipeRevision: tag.recipeRevision,
      params: {
        songId: tag.params.songId,
        labelId:
          typeof tag.params.labelId === 'string' ? tag.params.labelId : null,
      },
      start: index,
      end,
    });
    index = end;
  }
  const seen = new Map<string, number>();
  for (const run of runs) seen.set(run.useId, (seen.get(run.useId) ?? 0) + 1);
  return runs.filter((run) => seen.get(run.useId) === 1);
}
