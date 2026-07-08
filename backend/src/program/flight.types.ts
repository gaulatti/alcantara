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

export interface FlightCue {
  id: string;
  kind: FlightCueKind;
  label?: string;

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
  createdAt: Date;
  updatedAt: Date;
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
}
