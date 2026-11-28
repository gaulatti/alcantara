import type { FlightDesiredState } from './flight-resolver.types';
import type { FlightCue } from './flight.types';

/**
 * The rundown shadow (gaulatti/alcantara#123, slice A): what the pure resolver says should be on air, compared with
 * what the executor and the program have, field by field. Observation only: nothing here changes what airs.
 */
export const RUNDOWN_SHADOW_FIELDS = ['cue', 'scene', 'song'] as const;
export type RundownShadowField = (typeof RUNDOWN_SHADOW_FIELDS)[number];
export const RUNDOWN_SHADOW_RESULTS = ['agree', 'disagree', 'unsupported'] as const;
export type RundownShadowResult = (typeof RUNDOWN_SHADOW_RESULTS)[number];

/** What is on air as the executor and the program see it. */
export interface ShadowObservation {
  activeCueId: string | null;
  sceneId: number | null;
  songId: number | null;
}

/** Field by field; a song is compared by id only, since the engine reports its position asynchronously. */
export function compareShadow(
  desired: FlightDesiredState,
  observed: ShadowObservation,
): Record<RundownShadowField, 'agree' | 'disagree'> {
  const same = (left: unknown, right: unknown) => (left === right ? 'agree' : 'disagree');
  return {
    cue: same(desired.activeCueId, observed.activeCueId),
    scene: same(desired.scene?.sceneId ?? null, observed.sceneId),
    song: same(desired.song?.songId ?? null, observed.songId),
  };
}

/** A wait shorter than this cannot be told from the cue after it by a clock read a few milliseconds late. */
const SHORTEST_OBSERVED_WAIT_MS = 200;

/**
 * Whether a cue the executor waits on is observed as it begins: a wait for a song end, or a wait long enough that the
 * resolver is still on it a few milliseconds later.
 */
export function shadowObserves(cue: FlightCue): boolean {
  if (cue.kind === 'waitForSongEnd') return true;
  return cue.kind === 'wait' && typeof cue.durationMs === 'number' && cue.durationMs >= SHORTEST_OBSERVED_WAIT_MS;
}
