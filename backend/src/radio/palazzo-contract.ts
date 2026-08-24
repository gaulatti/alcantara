export type PalazzoProgramType = 'radio' | 'both';

export interface PalazzoAudioLevel {
  rms: number;
  peak: number;
}

export interface PalazzoLevels {
  song: PalazzoAudioLevel;
  instant: PalazzoAudioLevel;
  output: PalazzoAudioLevel;
}

export interface PalazzoTrackState {
  playbackRequestId: string;
  title: string | null;
  artist: string | null;
  coverUrl: string | null;
  url: string;
  startedAt: string;
}

export interface PalazzoPlaybackState {
  schemaVersion: number;
  instanceId: string;
  bootId: string;
  sequence: number;
  availability: 'available' | 'degraded';
  status: 'idle' | 'playing';
  liquidsoap: {
    running: boolean;
    connected: boolean;
    staleSince: string | null;
    lastSampleAt: string | null;
  };
  track: PalazzoTrackState | null;
  positionSeconds: number;
  remainingSeconds: number | null;
  levels: PalazzoLevels;
}

export type PalazzoPlaybackEventType =
  | 'snapshot'
  | 'telemetry.connected'
  | 'telemetry.disconnected'
  | 'track.started'
  | 'track.ended'
  | 'playback.position'
  | 'audio.levels'
  | 'heartbeat';

export interface PalazzoPlaybackEvent {
  schemaVersion: number;
  id: string;
  instanceId: string;
  bootId: string;
  sequence: number;
  type: PalazzoPlaybackEventType;
  occurredAt: string;
  data: Record<string, unknown>;
}

export type PalazzoConnectionState =
  | 'connecting'
  | 'connected'
  | 'polling'
  | 'unavailable'
  | 'instance-mismatch'
  | 'instance-conflict';

export interface PalazzoProgramStatus {
  programId: string;
  programType: PalazzoProgramType;
  palazzoUrl: string;
  instanceId: string | null;
  connection: PalazzoConnectionState;
  lastEventAt: string | null;
  lastSnapshotAt: string | null;
  degraded: boolean;
  detail: string | null;
}

export interface PalazzoTrackStartedData {
  playbackRequestId: string;
  title: string | null;
  artist: string | null;
  coverUrl: string | null;
  url: string;
  liquidsoapSequence: number;
}

export interface PalazzoTrackEndedData {
  playbackRequestId: string;
  title: string | null;
  artist: string | null;
  coverUrl: string | null;
  url: string;
  liquidsoapSequence: number;
}

export function parsePalazzoState(value: unknown): PalazzoPlaybackState | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.instanceId !== 'string') return null;
  if (typeof record.bootId !== 'string') return null;
  if (typeof record.sequence !== 'number') return null;
  const track =
    record.track && typeof record.track === 'object'
      ? parsePalazzoTrack(record.track)
      : null;
  const levels =
    record.levels && typeof record.levels === 'object'
      ? (record.levels as PalazzoLevels)
      : null;
  return {
    schemaVersion: typeof record.schemaVersion === 'number' ? record.schemaVersion : 1,
    instanceId: record.instanceId,
    bootId: record.bootId,
    sequence: record.sequence,
    availability: record.availability === 'degraded' ? 'degraded' : 'available',
    status: record.status === 'playing' ? 'playing' : 'idle',
    liquidsoap: {
      running: readLiquidsoap(record.liquidsoap, 'running') === true,
      connected: readLiquidsoap(record.liquidsoap, 'connected') === true,
      staleSince: readLiquidsoapString(record.liquidsoap, 'staleSince'),
      lastSampleAt: readLiquidsoapString(record.liquidsoap, 'lastSampleAt'),
    },
    track,
    positionSeconds: nonNegativeNumber(record.positionSeconds),
    remainingSeconds:
      typeof record.remainingSeconds === 'number' && record.remainingSeconds >= 0
        ? record.remainingSeconds
        : null,
    levels: levels ?? {
      song: { rms: 0, peak: 0 },
      instant: { rms: 0, peak: 0 },
      output: { rms: 0, peak: 0 },
    },
  };
}

function parsePalazzoTrack(value: unknown): PalazzoTrackState | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.playbackRequestId !== 'string') return null;
  return {
    playbackRequestId: record.playbackRequestId,
    title: stringOrNull(record.title),
    artist: stringOrNull(record.artist),
    coverUrl: stringOrNull(record.coverUrl),
    url: typeof record.url === 'string' ? record.url : '',
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function readLiquidsoap(
  value: unknown,
  key: string,
): unknown {
  if (!value || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[key];
}

function readLiquidsoapString(
  value: unknown,
  key: string,
): string | null {
  return stringOrNull(readLiquidsoap(value, key));
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}
