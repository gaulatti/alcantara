export type PalazzoProgramType = 'radio' | 'both';

export interface PalazzoAudioLevel {
  rms: number;
  peak: number;
}

export interface PalazzoLevels {
  song: PalazzoAudioLevel;
  intro?: PalazzoAudioLevel;
  instant: PalazzoAudioLevel;
  output: PalazzoAudioLevel;
}

export interface PalazzoIntroState {
  playbackId: string;
  parentPlaybackId: string;
  programId: string;
  playbackRequestId: string;
  url: string;
  startedAt: string;
  status: 'playing' | 'failed';
  failureReason?: string;
}

export interface PalazzoMixerState {
  mainVolume: number;
  songVolume: number;
  instantVolume: number;
  songMuted: boolean;
  instantMuted: boolean;
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
  icecast: { connected: boolean };
  track: PalazzoTrackState | null;
  intro: PalazzoIntroState | null;
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
  | 'intro.started'
  | 'intro.ended'
  | 'intro.failed'
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
  if (record.schemaVersion !== 1) return null;
  if (typeof record.instanceId !== 'string') return null;
  if (typeof record.bootId !== 'string') return null;
  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 0)
    return null;
  if (record.availability !== 'available' && record.availability !== 'degraded')
    return null;
  if (record.status !== 'idle' && record.status !== 'playing') return null;
  const track = record.track === null ? null : parsePalazzoTrack(record.track);
  if (record.track !== null && !track) return null;
  const intro = record.intro === null ? null : parsePalazzoIntro(record.intro);
  if (record.intro !== null && record.intro !== undefined && !intro)
    return null;
  const levels = parsePalazzoLevels(record.levels);
  if (!levels) return null;
  const liquidsoap = record.liquidsoap as Record<string, unknown> | undefined;
  const icecast = record.icecast as Record<string, unknown> | undefined;
  if (
    !liquidsoap ||
    typeof liquidsoap.running !== 'boolean' ||
    typeof liquidsoap.connected !== 'boolean' ||
    (liquidsoap.staleSince !== null &&
      typeof liquidsoap.staleSince !== 'string') ||
    (liquidsoap.lastSampleAt !== null &&
      typeof liquidsoap.lastSampleAt !== 'string') ||
    !icecast ||
    typeof icecast.connected !== 'boolean'
  )
    return null;
  if (!isNonNegativeFinite(record.positionSeconds)) return null;
  if (
    record.remainingSeconds !== null &&
    !isNonNegativeFinite(record.remainingSeconds)
  )
    return null;
  return {
    schemaVersion: 1,
    instanceId: record.instanceId,
    bootId: record.bootId,
    sequence: record.sequence as number,
    availability: record.availability,
    status: record.status,
    liquidsoap: {
      running: liquidsoap.running,
      connected: liquidsoap.connected,
      staleSince: liquidsoap.staleSince,
      lastSampleAt: liquidsoap.lastSampleAt,
    },
    icecast: { connected: icecast.connected },
    track,
    intro,
    positionSeconds: record.positionSeconds as number,
    remainingSeconds: record.remainingSeconds as number | null,
    levels,
  };
}

function parsePalazzoTrack(value: unknown): PalazzoTrackState | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!boundedString(record.playbackRequestId, 200)) return null;
  if (typeof record.url !== 'string' || !record.url) return null;
  if (
    typeof record.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.startedAt))
  )
    return null;
  return {
    playbackRequestId: record.playbackRequestId,
    title: stringOrNull(record.title),
    artist: stringOrNull(record.artist),
    coverUrl: stringOrNull(record.coverUrl),
    url: record.url,
    startedAt: record.startedAt,
  };
}

function parsePalazzoIntro(value: unknown): PalazzoIntroState | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    !boundedString(record.playbackId, 200) ||
    !boundedString(record.parentPlaybackId, 200) ||
    !boundedString(record.programId, 128) ||
    !boundedString(record.playbackRequestId, 200) ||
    typeof record.url !== 'string' ||
    typeof record.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.startedAt)) ||
    (record.status !== 'playing' && record.status !== 'failed') ||
    (record.failureReason !== undefined &&
      typeof record.failureReason !== 'string')
  )
    return null;
  return record as unknown as PalazzoIntroState;
}

function parsePalazzoLevels(value: unknown): PalazzoLevels | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const song = parseLevel(record.song);
  const instant = parseLevel(record.instant);
  const output = parseLevel(record.output);
  const intro =
    record.intro === undefined ? undefined : parseLevel(record.intro);
  if (!song || !instant || !output || (record.intro !== undefined && !intro))
    return null;
  return { song, instant, output, ...(intro ? { intro } : {}) };
}

function parseLevel(value: unknown): PalazzoAudioLevel | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!isFiniteNumber(record.rms) || !isFiniteNumber(record.peak)) return null;
  return { rms: record.rms as number, peak: record.peak as number };
}

export function parsePalazzoMixerState(
  value: unknown,
): PalazzoMixerState | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    !isFiniteNumber(record.mainVolume) ||
    !isFiniteNumber(record.songVolume) ||
    !isFiniteNumber(record.instantVolume) ||
    typeof record.songMuted !== 'boolean' ||
    typeof record.instantMuted !== 'boolean'
  )
    return null;
  return record as unknown as PalazzoMixerState;
}

export function parsePalazzoEvent(value: unknown): PalazzoPlaybackEvent | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const types: PalazzoPlaybackEventType[] = [
    'snapshot',
    'telemetry.connected',
    'telemetry.disconnected',
    'track.started',
    'track.ended',
    'intro.started',
    'intro.ended',
    'intro.failed',
    'playback.position',
    'audio.levels',
    'heartbeat',
  ];
  if (
    record.schemaVersion !== 1 ||
    !boundedString(record.id, 300) ||
    !boundedString(record.instanceId, 200) ||
    !boundedString(record.bootId, 200) ||
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 0 ||
    !types.includes(record.type as PalazzoPlaybackEventType) ||
    typeof record.occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(record.occurredAt)) ||
    !record.data ||
    typeof record.data !== 'object' ||
    Array.isArray(record.data)
  )
    return null;
  const type = record.type as PalazzoPlaybackEventType;
  const data = record.data as Record<string, unknown>;
  if (
    (type === 'track.started' || type === 'track.ended') &&
    (!boundedString(data.playbackRequestId, 200) ||
      typeof data.url !== 'string')
  )
    return null;
  if (
    (type === 'intro.started' ||
      type === 'intro.ended' ||
      type === 'intro.failed') &&
    (!boundedString(data.programId, 128) ||
      !boundedString(data.playbackId, 200) ||
      !boundedString(data.parentPlaybackId, 200))
  )
    return null;
  return record as unknown as PalazzoPlaybackEvent;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeFinite(value: unknown): boolean {
  return isFiniteNumber(value) && (value as number) >= 0;
}
