import type { PalazzoUnknownField } from './radio-metrics.service';

export type PalazzoProgramType = 'radio' | 'both';

/**
 * Called once for each value Alcantara does not know and reads as a safe
 * default (gaulatti/ariston#217). It receives the field, never the value.
 */
export type PalazzoUnknownSink = (field: PalazzoUnknownField) => void;

export interface PalazzoStateParseOptions {
  /** The status to keep when Palazzo reports one Alcantara does not know. */
  previousStatus?: 'idle' | 'playing';
  onUnknown?: PalazzoUnknownSink;
}

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
  /**
   * Whether Palazzo's live RTMP input is on the air (gaulatti/palazzo#48).
   * Absent from a Palazzo older than that field: the reader cannot tell a live
   * show from silence then, since `status` stays 'idle' during one.
   */
  live?: { onAir: boolean };
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
  | 'playout.queued'
  | 'preflight.ready'
  | 'preflight.failed'
  | 'playout.started'
  | 'playout.transitioned'
  | 'playout.stopped'
  | 'playout.skipped'
  | 'playout.fallback'
  | 'playout.request_failed'
  | 'playout.next_queued'
  | 'playout.next_withdrawn'
  | 'playback.position'
  | 'audio.levels'
  | 'heartbeat';

/**
 * Why Palazzo dropped an announced next song (contract palazzo#40 §3). A
 * reason Alcantara does not know is read as `other`.
 */
export type PalazzoNextWithdrawnReason =
  'replaced' | 'withdrawn' | 'flushed' | 'not_ready' | 'other';

const NEXT_WITHDRAWN_REASONS: ReadonlySet<string> = new Set([
  'replaced',
  'withdrawn',
  'flushed',
  'not_ready',
]);

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
  url?: string;
  liquidsoapSequence: number;
}

export interface PalazzoTrackEndedData {
  playbackRequestId: string;
  title: string | null;
  artist: string | null;
  coverUrl: string | null;
  url?: string;
  liquidsoapSequence: number;
}

/**
 * Parses a Palazzo playback state. `schemaVersion` is the major version and
 * stays a strict pin. Within it, an `availability`, `status` or intro `status`
 * Alcantara does not know does not drop the state (gaulatti/ariston#217):
 * availability reads as `degraded`, status as the previous status or `idle`,
 * and the intro as absent, each reported to `onUnknown`. A missing or mistyped
 * known field still rejects the state.
 */
export function parsePalazzoState(
  value: unknown,
  options: PalazzoStateParseOptions = {},
): PalazzoPlaybackState | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) return null;
  if (typeof record.instanceId !== 'string') return null;
  if (typeof record.bootId !== 'string') return null;
  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 0)
    return null;
  if (!boundedString(record.availability, 64)) return null;
  if (!boundedString(record.status, 64)) return null;
  let availability: PalazzoPlaybackState['availability'] = 'degraded';
  if (record.availability === 'available' || record.availability === 'degraded')
    availability = record.availability;
  else options.onUnknown?.('availability');
  let status: PalazzoPlaybackState['status'] = options.previousStatus ?? 'idle';
  if (record.status === 'idle' || record.status === 'playing')
    status = record.status;
  else options.onUnknown?.('status');
  const track = record.track === null ? null : parsePalazzoTrack(record.track);
  if (record.track !== null && !track) return null;
  const parsedIntro =
    record.intro === null || record.intro === undefined
      ? null
      : parsePalazzoIntro(record.intro);
  if (parsedIntro === 'malformed') return null;
  if (parsedIntro === 'unknown-status') options.onUnknown?.('intro-status');
  const intro = parsedIntro === 'unknown-status' ? null : parsedIntro;
  const levels = parsePalazzoLevels(record.levels);
  if (!levels) return null;
  const live = record.live as Record<string, unknown> | undefined;
  if (
    live !== undefined &&
    (!live || typeof live !== 'object' || typeof live.onAir !== 'boolean')
  )
    return null;
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
    availability,
    status,
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
    ...(live ? { live: { onAir: live.onAir as boolean } } : {}),
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

function parsePalazzoIntro(
  value: unknown,
): PalazzoIntroState | 'malformed' | 'unknown-status' {
  if (!value || typeof value !== 'object') return 'malformed';
  const record = value as Record<string, unknown>;
  if (
    !boundedString(record.playbackId, 200) ||
    !boundedString(record.parentPlaybackId, 200) ||
    !boundedString(record.programId, 128) ||
    !boundedString(record.playbackRequestId, 200) ||
    typeof record.url !== 'string' ||
    typeof record.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.startedAt)) ||
    !boundedString(record.status, 64) ||
    (record.failureReason !== undefined &&
      typeof record.failureReason !== 'string')
  )
    return 'malformed';
  if (record.status !== 'playing' && record.status !== 'failed')
    return 'unknown-status';
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

const EVENT_TYPES: ReadonlySet<string> = new Set<PalazzoPlaybackEventType>([
  'snapshot',
  'telemetry.connected',
  'telemetry.disconnected',
  'track.started',
  'track.ended',
  'intro.started',
  'intro.ended',
  'intro.failed',
  'playout.queued',
  'preflight.ready',
  'preflight.failed',
  'playout.started',
  'playout.transitioned',
  'playout.stopped',
  'playout.skipped',
  'playout.fallback',
  'playout.request_failed',
  'playout.next_queued',
  'playout.next_withdrawn',
  'playback.position',
  'audio.levels',
  'heartbeat',
]);

/** The correlation fields every Palazzo event carries, whatever its type. */
export interface PalazzoEventEnvelope {
  id: string;
  instanceId: string;
  bootId: string;
  sequence: number;
  occurredAt: string;
}

/**
 * What one SSE frame is (gaulatti/ariston#217). The client skips, rather than
 * drops the stream for:
 * - `unknown-type`: a well-formed frame of a type Alcantara does not know; its
 *   envelope still advances the sequence cursor;
 * - `unsupported-version`: a frame whose integer `schemaVersion` (the major
 *   version) is not 1. Nothing else of it is read, because another major may
 *   change what every field means.
 * Anything else that fails the contract is `malformed`.
 */
export type PalazzoFrame =
  | { kind: 'event'; event: PalazzoPlaybackEvent }
  | { kind: 'unknown-type'; envelope: PalazzoEventEnvelope }
  | { kind: 'unsupported-version' }
  | { kind: 'malformed' };

/** Parses a known Palazzo event, or null for anything else. */
export function parsePalazzoEvent(
  value: unknown,
  onUnknown?: PalazzoUnknownSink,
): PalazzoPlaybackEvent | null {
  const frame = classifyPalazzoFrame(value, onUnknown);
  return frame.kind === 'event' ? frame.event : null;
}

export function classifyPalazzoFrame(
  value: unknown,
  onUnknown?: PalazzoUnknownSink,
): PalazzoFrame {
  const malformed: PalazzoFrame = { kind: 'malformed' };
  if (!value || typeof value !== 'object') return malformed;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    return Number.isSafeInteger(record.schemaVersion)
      ? { kind: 'unsupported-version' }
      : malformed;
  }
  if (
    !boundedString(record.id, 300) ||
    !boundedString(record.instanceId, 200) ||
    !boundedString(record.bootId, 200) ||
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 0 ||
    !boundedString(record.type, 200) ||
    typeof record.occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(record.occurredAt)) ||
    !record.data ||
    typeof record.data !== 'object' ||
    Array.isArray(record.data)
  )
    return malformed;
  if (!EVENT_TYPES.has(record.type)) {
    return {
      kind: 'unknown-type',
      envelope: {
        id: record.id,
        instanceId: record.instanceId,
        bootId: record.bootId,
        sequence: record.sequence as number,
        occurredAt: record.occurredAt,
      },
    };
  }
  const type = record.type as PalazzoPlaybackEventType;
  const data = record.data as Record<string, unknown>;
  if (
    (type === 'track.started' ||
      type === 'track.ended' ||
      type === 'playout.request_failed') &&
    !boundedString(data.playbackRequestId, 200)
  )
    return malformed;
  if (
    (type === 'playout.next_queued' || type === 'playout.next_withdrawn') &&
    !boundedString(data.playbackId, 200)
  )
    return malformed;
  if (type === 'playout.next_withdrawn') {
    if (!boundedString(data.reason, 64)) return malformed;
    if (!NEXT_WITHDRAWN_REASONS.has(data.reason)) {
      onUnknown?.('withdrawn-reason');
      data.reason = 'other';
    }
  }
  if (
    (type === 'intro.started' ||
      type === 'intro.ended' ||
      type === 'intro.failed') &&
    (!boundedString(data.programId, 128) ||
      !boundedString(data.playbackId, 200) ||
      !boundedString(data.parentPlaybackId, 200))
  )
    return malformed;
  return { kind: 'event', event: record as unknown as PalazzoPlaybackEvent };
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
