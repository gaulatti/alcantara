import type { FlightCue, FlightCueKind, FlightMixerChange, FlightSequence } from '../models/broadcast';

const VALID_CUE_KINDS: Set<FlightCueKind> = new Set([
  'scene',
  'playSong',
  'stopSong',
  'wait',
  'waitForSongEnd',
  'sceneUpdate',
  'instant',
  'mixer'
]);

const VALID_MIXER_CHANNEL_IDS: Set<FlightMixerChange['channelId']> = new Set([
  'main',
  'song',
  'instants',
  'sceneInstant',
  'stream'
]);

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }
  return undefined;
}

export function normalizeFlightCue(value: unknown): FlightCue | null {
  if (!isRecord(value)) {
    return null;
  }

  const kind = value.kind;
  if (typeof kind !== 'string' || !VALID_CUE_KINDS.has(kind as FlightCueKind)) {
    return null;
  }

  const cue: FlightCue = {
    id: typeof value.id === 'string' && value.id.trim().length > 0 ? value.id.trim() : createId('cue'),
    kind: kind as FlightCueKind,
    label: normalizeOptionalString(value.label)
  };

  const sceneId = normalizeOptionalNumber(value.sceneId);
  if (sceneId !== undefined) {
    cue.sceneId = sceneId;
  }

  const transitionId = normalizeOptionalString(value.transitionId);
  if (transitionId !== undefined) {
    cue.transitionId = transitionId;
  }

  const songId = normalizeOptionalNumber(value.songId);
  if (songId !== undefined) {
    cue.songId = songId;
  }

  const durationMs = normalizeOptionalNumber(value.durationMs);
  if (durationMs !== undefined && durationMs >= 0) {
    cue.durationMs = durationMs;
  }

  if (isRecord(value.metadataPatch)) {
    cue.metadataPatch = value.metadataPatch as Record<string, unknown>;
  }

  const instantId = normalizeOptionalNumber(value.instantId);
  if (instantId !== undefined) {
    cue.instantId = instantId;
  }

  if (isRecord(value.mixerChange)) {
    const change: FlightMixerChange = {};
    const channelId = value.mixerChange.channelId;
    if (VALID_MIXER_CHANNEL_IDS.has(channelId as FlightMixerChange['channelId'])) {
      change.channelId = channelId as FlightMixerChange['channelId'];
    }
    const volume = normalizeOptionalNumber(value.mixerChange.volume);
    if (volume !== undefined) {
      change.volume = volume;
    }
    if (typeof value.mixerChange.muted === 'boolean') {
      change.muted = value.mixerChange.muted;
    }
    if (typeof value.mixerChange.solo === 'boolean') {
      change.solo = value.mixerChange.solo;
    }
    cue.mixerChange = change;
  }

  return cue;
}

export function normalizeFlightSequence(value: unknown): FlightSequence | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawItems = Array.isArray(value.items) ? value.items : [];
  const items = rawItems
    .map(normalizeFlightCue)
    .filter((cue): cue is FlightCue => cue !== null);

  return {
    id: typeof value.id === 'number' && Number.isFinite(value.id) ? value.id : 0,
    name: typeof value.name === 'string' ? value.name : 'Unnamed',
    items,
    loop: value.loop === true,
    isRunning: value.isRunning === true,
    activeItemId: value.activeItemId === null || typeof value.activeItemId === 'string' ? value.activeItemId : null,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString()
  };
}

export function createFlightCue(kind: FlightCueKind = 'wait'): FlightCue {
  const cue: FlightCue = {
    id: createId('cue'),
    kind
  };

  if (kind === 'wait') {
    cue.durationMs = 3000;
  }

  if (kind === 'scene') {
    cue.transitionId = 'cut';
  }

  return cue;
}

export function getFlightCueDisplayLabel(
  cue: FlightCue,
  context?: {
    scenes?: { id: number; name: string }[];
    songs?: { id: number; title: string; artist: string }[];
    instants?: { id: number; name: string }[];
  }
): string {
  if (cue.label) {
    return cue.label;
  }

  switch (cue.kind) {
    case 'scene':
      if (cue.sceneId !== undefined) {
        const scene = context?.scenes?.find((s) => s.id === cue.sceneId);
        return scene ? `Scene: ${scene.name}` : `Scene ${cue.sceneId}`;
      }
      return 'Scene';
    case 'playSong':
      if (cue.songId !== undefined) {
        const song = context?.songs?.find((s) => s.id === cue.songId);
        return song ? `Play: ${song.artist} - ${song.title}` : `Play song ${cue.songId}`;
      }
      return 'Play song';
    case 'stopSong':
      return 'Stop song';
    case 'wait':
      return cue.durationMs !== undefined ? `Wait ${cue.durationMs}ms` : 'Wait';
    case 'waitForSongEnd':
      return 'Wait for song end';
    case 'sceneUpdate':
      return cue.sceneId !== undefined ? `Update scene ${cue.sceneId}` : 'Update scene';
    case 'instant':
      if (cue.instantId !== undefined) {
        const instant = context?.instants?.find((i) => i.id === cue.instantId);
        return instant ? `Instant: ${instant.name}` : `Instant ${cue.instantId}`;
      }
      return 'Instant';
    case 'mixer':
      if (cue.mixerChange?.channelId) {
        const parts: string[] = [cue.mixerChange.channelId];
        if (typeof cue.mixerChange.volume === 'number') parts.push(`vol ${Math.round(cue.mixerChange.volume * 100)}%`);
        if (typeof cue.mixerChange.muted === 'boolean') parts.push(cue.mixerChange.muted ? 'mute' : 'unmute');
        if (typeof cue.mixerChange.solo === 'boolean') parts.push(cue.mixerChange.solo ? 'solo' : 'unsolo');
        return `Mixer: ${parts.join(' ')}`;
      }
      return 'Mixer';
    default:
      return 'Cue';
  }
}
