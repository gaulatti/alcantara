import type { FlightMixerChange } from './flight.types';

/** The mixer channels a flight cue can address. */
export type FlightMixerChannel = NonNullable<FlightMixerChange['channelId']>;

/** A channel's level as the cues so far have set it; unset fields are left alone. */
export type FlightMixerChannelState = Omit<FlightMixerChange, 'channelId'>;

/**
 * What should be on air at one moment of a flight sequence, as computed by
 * `resolve` in `flight-resolver.ts` (gaulatti/alcantara#152).
 */
export interface FlightDesiredState {
  /** The scene on Program and the transition that brought it, or none yet. */
  scene: { sceneId: number; transitionId: string | null } | null;
  /** `sceneUpdate` metadata patches merged, in order, since that scene was taken. */
  sceneMetadataPatch: Record<string, unknown>;
  /** The song that should be playing and how far into it, or none. */
  song: { songId: number | null; positionMs: number } | null;
  /** The level each addressed mixer channel should have. */
  mixer: Partial<Record<FlightMixerChannel, FlightMixerChannelState>>;
  /** The cue in effect: the one being waited on, the last one applied, or none. */
  activeCueId: string | null;
  /** True once a non-looping sequence has run past its last cue. */
  finished: boolean;
}
