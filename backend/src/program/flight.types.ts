export type FlightCueKind =
  | 'scene'
  | 'playSong'
  | 'stopSong'
  | 'wait'
  | 'waitForSongEnd'
  | 'sceneUpdate'
  | 'instant'
  | 'mixer';

export interface FlightMixerChange {
  channelId?: 'main' | 'song' | 'instants' | 'sceneInstant' | 'stream';
  volume?: number;
  muted?: boolean;
  solo?: boolean;
}

/**
 * The recipe use a rundown cue belongs to (gaulatti/alcantara#222, contract C1). A cue of one use
 * shares `useId`; its id is `<useId>.<step>` (C2). Cues carry it for grouping only: the resolver and
 * the executor ignore it.
 */
export interface FlightRecipeUse {
  useId: string;
  recipeId: number;
  recipeRevision: number;
  step: string;
  params: { songId: number; labelId?: string | null };
}

export interface FlightCue {
  isFiller?: boolean;
  // A rundown cue's recipe use, when it came from a recipe (gaulatti/alcantara#422).
  recipeUse?: FlightRecipeUse;
  id: string;
  kind: FlightCueKind;
  label?: string;
  // Scheduled radio log: elapsed seconds from the log's scheduled hour.
  clockOffsetSeconds?: number;
  // A recorded link for this log position, distinct from a catalog song intro.
  voiceTrackInstantId?: number;
  voiceDuckGain?: number;
  voiceFadeInSeconds?: number;
  voiceFadeOutSeconds?: number;

  // scene / sceneUpdate
  sceneId?: number;

  // scene only
  transitionId?: string;

  // playSong only
  songId?: number;

  // sceneUpdate only
  metadataPatch?: Record<string, unknown>;

  // wait only
  durationMs?: number;

  // instant only
  instantId?: number;

  // mixer only
  mixerChange?: FlightMixerChange;
}

export interface FlightSequence {
  id: number;
  programStateId: number;
  name: string;
  items: FlightCue[];
  loop: boolean;
  isRunning: boolean;
  activeItemId: string | null;
  scheduledAt: Date | null;
  publishedAt: Date | null;
  revision: number;
  lastStartedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A rundown cue that was logged as not aired (gaulatti/alcantara#726). `reason` is the as-run row's
 * end reason, such as `engine_unavailable`.
 */
export interface FlightCueOutcome {
  cueId: string;
  state: 'not-aired';
  reason: string | null;
}

export interface FlightRuntimeState {
  sequenceId: number;
  programId: string;
  items: FlightCue[];
  loop: boolean;
  activeIndex: number;
  isRunning: boolean;
  generation: number;
  timer: NodeJS.Timeout | null;
  waitingForSongEnd: boolean;
  startedAt: number;
  cueStartedAt?: number;
  scheduledAtMs: number | null;
  /** A timed-block cue held through an engine outage (#719): its row and the time its grace runs from. */
  engineRetry?: { index: number; dueAt: number };
}
