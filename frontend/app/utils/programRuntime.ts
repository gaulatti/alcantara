// Moved byte-for-byte from routes/program.tsx (gaulatti/alcantara#195) so the pure helpers can be tested; only `export` was added.
import { normalizeProgramSongSequence, type ProgramSongSequence, type ProgramSongSequenceItem } from './programSequence';
import { sceneInstantBelongsToActiveScene } from './programSceneInstant';
import type { SceneTransitionPreset } from './sceneTransitions';

export interface Layout {
  id: number;
  name: string;
  componentType: string;
  settings: string;
}

export interface Scene {
  id: number;
  name: string;
  layoutId: number;
  layout: Layout;
  chyronText: string | null;
  metadata: string | null;
}

export interface ProgramState {
  id: number;
  programId?: string;
  activeSceneId: number | null;
  activeScene: Scene | null;
  stagedSceneId?: number | null;
  stagedScene?: Scene | null;
  fadeToBlack?: boolean;
  updatedAt: string;
}

export interface BroadcastSettings {
  id: number;
  timeOverrideEnabled: boolean;
  timeOverrideStartTime: string | null;
  timeOverrideStartedAt: string | null;
  mainMasterVolume: number;
  songMasterVolume: number;
  instantMasterVolume: number;
  sceneInstantMasterVolume: number;
  streamMasterVolume: number;
  songMuted: boolean;
  instantMuted: boolean;
  sceneInstantMuted: boolean;
  streamMuted: boolean;
  songSolo: boolean;
  instantSolo: boolean;
  sceneInstantSolo: boolean;
  streamSolo: boolean;
  mixerChannels: ProgramMixerChannel[];
  updatedAt: string;
}

export interface ProgramMixerChannel {
  id: string;
  name: string;
  volume: number;
  muted: boolean;
  solo: boolean;
}

export interface SceneChangeEvent {
  type: 'scene_change';
  transitionId?: string | null;
  state: ProgramState;
}

export interface InstantPlayEvent {
  type: 'instant_play';
  programId?: string;
  instant: {
    id: number;
    name: string;
    audioUrl: string;
    volume: number;
  };
  triggeredAt: string;
}

export interface SceneInstantTakeEvent {
  type: 'scene_instant_take';
  programId?: string;
  sceneId?: number | null;
  instant: {
    id: number | null;
    assetId?: string | null;
    name: string;
    audioUrl: string;
    volume: number;
  };
  loop?: boolean;
  triggeredAt: string;
}

export interface SceneInstantStateEvent {
  type: 'scene_instant_state';
  programId?: string;
  playback?: {
    sceneId?: number | null;
    instantId?: number | null;
    mediaAssetId?: string | null;
    isPlaying?: boolean;
    instant?: {
      id: number | null;
      assetId?: string | null;
      name: string;
      audioUrl: string;
      volume: number;
    } | null;
    startedAt?: string | null;
    updatedAt?: string;
  } | null;
}

export interface ActiveTransition {
  sequence: number;
  preset: SceneTransitionPreset;
}

export interface InstantAudioRuntimeState {
  baseVolume: number;
  meterSource: AudioNode | null;
  meterAnalyser: AnalyserNode | null;
  meterBuffer: Float32Array<ArrayBuffer> | null;
  meterUsesMediaElementFallback: boolean;
}

export interface SongOffAirEvent {
  type: 'song_off_air';
  programId: string;
  triggeredAt: string;
}

export interface ProgramReloadEvent {
  type: 'program_reload';
  programId?: string;
  triggeredAt?: string;
}

export interface ProgramAudioBusSettings {
  songSequence?: unknown;
  mixerSettings?: ProgramAudioMixerSettings | null;
}

export interface ProgramAudioMixerSettings {
  mainMasterVolume: number;
  songMasterVolume: number;
  instantMasterVolume: number;
  sceneInstantMasterVolume: number;
  streamMasterVolume: number;
  songMuted: boolean;
  instantMuted: boolean;
  sceneInstantMuted: boolean;
  streamMuted: boolean;
  songSolo: boolean;
  instantSolo: boolean;
  sceneInstantSolo: boolean;
  streamSolo: boolean;
  mixerChannels: ProgramMixerChannel[];
}

export interface SlideshowMediaItem {
  id: number;
  name: string;
  imageUrl: string;
}

export interface SlideshowMediaGroupItem {
  id: number;
  mediaGroupId: number;
  mediaId: number;
  position: number;
  media: SlideshowMediaItem;
}

export interface SlideshowMediaGroup {
  id: number;
  name: string;
  description: string | null;
  items: SlideshowMediaGroupItem[];
}

export interface SlideshowMediaLabel {
  id: string;
  name: string;
  images: Array<{
    assetId: string;
    name: string;
    imageUrl: string;
    position: number;
  }>;
}

export interface AudioBusUpdateEvent {
  type: 'audio_bus_update';
  programId: string;
  settings: ProgramAudioBusSettings;
  updatedAt: string;
}

export interface MeterChannelPayload {
  vu: number;
  peak: number;
  peakHold: number;
}

export interface ProgramAudioMeterPayload {
  song: MeterChannelPayload;
  instants: MeterChannelPayload;
  sceneInstant: MeterChannelPayload;
  main: MeterChannelPayload;
  version?: number;
}

export interface MeterChannelBallistics {
  vu: number;
  peak: number;
  peakHold: number;
  peakHoldAtMs: number;
}

export interface ProgramMeterBallisticsState {
  song: MeterChannelBallistics;
  instants: MeterChannelBallistics;
  sceneInstant: MeterChannelBallistics;
  main: MeterChannelBallistics;
  lastTickAtMs: number | null;
}

export type ProgramUpdateTopic = 'state' | 'audioBus' | 'audioMeter' | 'songPlayback' | 'sceneInstant' | 'broadcastSettings';

export const VU_ATTACK_MS = 300;
export const VU_RELEASE_MS = 300;
export const PEAK_RELEASE_MS = 300;
export const PEAK_HOLD_MS = 900;
export const METER_TICK_INTERVAL_MS = 60;
export const SCENE_INSTANT_SWITCH_FADE_MS = 1500;


export function normalizeUpdateVersion(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const normalized = Math.floor(numeric);
  if (normalized < 0) {
    return null;
  }
  return normalized;
}

export function resolveProgramUpdateTopicFromType(type: unknown): ProgramUpdateTopic | null {
  if (typeof type !== 'string') {
    return null;
  }

  switch (type) {
    case 'program_state_snapshot':
    case 'scene_change':
    case 'scene_staged':
    case 'fade_to_black':
    case 'scene_update':
    case 'scene_cleared':
    case 'program_scenes_changed':
    case 'program_stingers_changed':
      return 'state';
    case 'audio_bus_snapshot':
    case 'audio_bus_update':
      return 'audioBus';
    case 'audio_meter_update':
      return 'audioMeter';
    case 'song_playback_update':
    case 'song_off_air':
      return 'songPlayback';
    case 'scene_instant_state':
    case 'scene_instant_take':
    case 'scene_instant_stop':
      return 'sceneInstant';
    case 'broadcast_settings_snapshot':
    case 'broadcast_settings_update':
      return 'broadcastSettings';
    default:
      return null;
  }
}

export function readProgramTopicVersion(topic: ProgramUpdateTopic, payload: unknown): number | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const topLevel = normalizeUpdateVersion(record.version);
  if (topLevel !== null) {
    return topLevel;
  }

  switch (topic) {
    case 'state':
      return normalizeUpdateVersion((record.state as Record<string, unknown> | undefined)?.version ?? record.stateVersion);
    case 'audioBus':
      return normalizeUpdateVersion((record.settings as Record<string, unknown> | undefined)?.version ?? record.audioBusVersion);
    case 'audioMeter':
      return normalizeUpdateVersion((record.levels as Record<string, unknown> | undefined)?.version ?? record.audioMeterVersion);
    case 'songPlayback':
      return normalizeUpdateVersion((record.playback as Record<string, unknown> | undefined)?.version ?? record.songPlaybackVersion);
    case 'sceneInstant':
      return normalizeUpdateVersion((record.playback as Record<string, unknown> | undefined)?.version ?? record.sceneInstantVersion);
    case 'broadcastSettings':
      return normalizeUpdateVersion((record.settings as Record<string, unknown> | undefined)?.version ?? record.broadcastSettingsVersion);
    default:
      return null;
  }
}

export function createMeterChannelBallistics(): MeterChannelBallistics {
  return {
    vu: 0,
    peak: 0,
    peakHold: 0,
    peakHoldAtMs: 0
  };
}

export function createProgramMeterBallisticsState(): ProgramMeterBallisticsState {
  return {
    song: createMeterChannelBallistics(),
    instants: createMeterChannelBallistics(),
    sceneInstant: createMeterChannelBallistics(),
    main: createMeterChannelBallistics(),
    lastTickAtMs: null
  };
}

export function createInstantAudioMeterContext(): AudioContext | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }
  try {
    return new AudioContextCtor();
  } catch {
    return null;
  }
}

export function flattenProgramSongItems(items: ProgramSongSequenceItem[]): Extract<ProgramSongSequenceItem, { kind: 'preset' }>[] {
  const flattened: Extract<ProgramSongSequenceItem, { kind: 'preset' }>[] = [];

  for (const item of items) {
    if (item.kind === 'preset') {
      flattened.push(item);
      continue;
    }

    flattened.push(...flattenProgramSongItems(item.sequence.items));
  }

  return flattened;
}

export function normalizeProgramSongPlaylist(sequence: ProgramSongSequence): ProgramSongSequence {
  const playlistItems = flattenProgramSongItems(sequence.items);
  const activeItemId =
    sequence.activeItemId === null
      ? null
      : sequence.activeItemId && playlistItems.some((item) => item.id === sequence.activeItemId)
        ? sequence.activeItemId
        : (playlistItems[0]?.id ?? null);

  return {
    ...sequence,
    items: playlistItems,
    activeItemId
  };
}

export function normalizeProgramAudioBusSettings(value: unknown): ProgramAudioBusSettings {
  if (!value || typeof value !== 'object') {
    return {
      songSequence: null,
      mixerSettings: null
    };
  }

  const record = value as Record<string, unknown>;
  const normalizedSongSequence = normalizeProgramSongSequence(record.songSequence);
  const hasMixerSettings = Object.prototype.hasOwnProperty.call(record, 'mixerSettings');

  return {
    songSequence: normalizedSongSequence ? normalizeProgramSongPlaylist(normalizedSongSequence) : null,
    mixerSettings: hasMixerSettings ? normalizeProgramAudioMixerSettings(record.mixerSettings) : null
  };
}

export function normalizeMasterVolume(value: unknown, fallback: number = 1): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  return fallback;
}

export function normalizeMixerToggle(value: unknown, fallback: boolean = false): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  return fallback;
}

export function normalizeSlideshowMediaGroupId(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || !Number.isInteger(numeric)) {
    return null;
  }
  return numeric;
}

export function normalizeSlideshowLabelId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeProgramMixerChannels(value: unknown, fallback: ProgramMixerChannel[]): ProgramMixerChannel[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const byId = new Map<string, ProgramMixerChannel>();
  for (const fallbackChannel of fallback) {
    byId.set(fallbackChannel.id, { ...fallbackChannel });
  }

  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id) {
      continue;
    }
    const previous = byId.get(id);
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : (previous?.name ?? id);
    byId.set(id, {
      id,
      name,
      volume: normalizeMasterVolume(record.volume, previous?.volume ?? 1),
      muted: normalizeMixerToggle(record.muted, previous?.muted ?? false),
      solo: normalizeMixerToggle(record.solo, previous?.solo ?? false)
    });
  }

  return [...byId.values()];
}

export function getProgramMixerChannel(channels: ProgramMixerChannel[], id: string): ProgramMixerChannel {
  const matched = channels.find((channel) => channel.id === id);
  if (matched) {
    return matched;
  }
  return {
    id,
    name: id,
    volume: 1,
    muted: false,
    solo: false
  };
}

export function normalizeProgramAudioMixerSettings(value: unknown): ProgramAudioMixerSettings {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const scalarFallback = {
    songMasterVolume: normalizeMasterVolume(record.songMasterVolume, 1),
    instantMasterVolume: normalizeMasterVolume(record.instantMasterVolume, 1),
    sceneInstantMasterVolume: normalizeMasterVolume(record.sceneInstantMasterVolume, 1),
    streamMasterVolume: normalizeMasterVolume(record.streamMasterVolume, 1),
    songMuted: normalizeMixerToggle(record.songMuted, false),
    instantMuted: normalizeMixerToggle(record.instantMuted, false),
    sceneInstantMuted: normalizeMixerToggle(record.sceneInstantMuted, false),
    streamMuted: normalizeMixerToggle(record.streamMuted, false),
    songSolo: normalizeMixerToggle(record.songSolo, false),
    instantSolo: normalizeMixerToggle(record.instantSolo, false),
    sceneInstantSolo: normalizeMixerToggle(record.sceneInstantSolo, false),
    streamSolo: normalizeMixerToggle(record.streamSolo, false)
  };
  const fallbackChannels: ProgramMixerChannel[] = [
    {
      id: 'song',
      name: 'Song',
      volume: scalarFallback.songMasterVolume,
      muted: scalarFallback.songMuted,
      solo: scalarFallback.songSolo
    },
    {
      id: 'stream',
      name: 'Stream',
      volume: scalarFallback.streamMasterVolume,
      muted: scalarFallback.streamMuted,
      solo: scalarFallback.streamSolo
    },
    {
      id: 'instants',
      name: 'Instants',
      volume: scalarFallback.instantMasterVolume,
      muted: scalarFallback.instantMuted,
      solo: scalarFallback.instantSolo
    },
    {
      id: 'sceneInstant',
      name: 'Scene Instant',
      volume: scalarFallback.sceneInstantMasterVolume,
      muted: scalarFallback.sceneInstantMuted,
      solo: scalarFallback.sceneInstantSolo
    }
  ];
  const mixerChannels = normalizeProgramMixerChannels(record.mixerChannels, fallbackChannels);
  const songChannel = getProgramMixerChannel(mixerChannels, 'song');
  const streamChannel = getProgramMixerChannel(mixerChannels, 'stream');
  const instantsChannel = getProgramMixerChannel(mixerChannels, 'instants');
  const sceneInstantChannel = getProgramMixerChannel(mixerChannels, 'sceneInstant');

  return {
    mainMasterVolume: normalizeMasterVolume(record.mainMasterVolume, 1),
    songMasterVolume: songChannel.volume,
    instantMasterVolume: instantsChannel.volume,
    sceneInstantMasterVolume: sceneInstantChannel.volume,
    streamMasterVolume: streamChannel.volume,
    songMuted: songChannel.muted,
    instantMuted: instantsChannel.muted,
    sceneInstantMuted: sceneInstantChannel.muted,
    streamMuted: streamChannel.muted,
    songSolo: songChannel.solo,
    instantSolo: instantsChannel.solo,
    sceneInstantSolo: sceneInstantChannel.solo,
    streamSolo: streamChannel.solo,
    mixerChannels
  };
}

export function normalizeBroadcastSettings(value: unknown): BroadcastSettings | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'number' && Number.isFinite(record.id) ? record.id : 1;
  const fallbackChannels: ProgramMixerChannel[] = [
    {
      id: 'song',
      name: 'Song',
      volume: normalizeMasterVolume(record.songMasterVolume, 1),
      muted: normalizeMixerToggle(record.songMuted, false),
      solo: normalizeMixerToggle(record.songSolo, false)
    },
    {
      id: 'stream',
      name: 'Stream',
      volume: normalizeMasterVolume(record.streamMasterVolume, 1),
      muted: normalizeMixerToggle(record.streamMuted, false),
      solo: normalizeMixerToggle(record.streamSolo, false)
    },
    {
      id: 'instants',
      name: 'Instants',
      volume: normalizeMasterVolume(record.instantMasterVolume, 1),
      muted: normalizeMixerToggle(record.instantMuted, false),
      solo: normalizeMixerToggle(record.instantSolo, false)
    },
    {
      id: 'sceneInstant',
      name: 'Scene Instant',
      volume: normalizeMasterVolume(record.sceneInstantMasterVolume, 1),
      muted: normalizeMixerToggle(record.sceneInstantMuted, false),
      solo: normalizeMixerToggle(record.sceneInstantSolo, false)
    }
  ];
  const mixerChannels = normalizeProgramMixerChannels(record.mixerChannels, fallbackChannels);
  const songChannel = getProgramMixerChannel(mixerChannels, 'song');
  const streamChannel = getProgramMixerChannel(mixerChannels, 'stream');
  const instantsChannel = getProgramMixerChannel(mixerChannels, 'instants');
  const sceneInstantChannel = getProgramMixerChannel(mixerChannels, 'sceneInstant');
  return {
    id,
    timeOverrideEnabled: Boolean(record.timeOverrideEnabled),
    timeOverrideStartTime: typeof record.timeOverrideStartTime === 'string' ? record.timeOverrideStartTime : null,
    timeOverrideStartedAt: typeof record.timeOverrideStartedAt === 'string' ? record.timeOverrideStartedAt : null,
    mainMasterVolume: normalizeMasterVolume(record.mainMasterVolume, 1),
    songMasterVolume: songChannel.volume,
    instantMasterVolume: instantsChannel.volume,
    sceneInstantMasterVolume: sceneInstantChannel.volume,
    streamMasterVolume: streamChannel.volume,
    songMuted: songChannel.muted,
    instantMuted: instantsChannel.muted,
    sceneInstantMuted: sceneInstantChannel.muted,
    streamMuted: streamChannel.muted,
    songSolo: songChannel.solo,
    instantSolo: instantsChannel.solo,
    sceneInstantSolo: sceneInstantChannel.solo,
    streamSolo: streamChannel.solo,
    mixerChannels,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString()
  };
}

export function sceneIncludesVideoStream(scene: Scene | null | undefined): boolean {
  if (!scene?.layout?.componentType) {
    return false;
  }
  return scene.layout.componentType
    .split(',')
    .map((componentType) => componentType.trim())
    .filter(Boolean)
    .some((componentType) => componentType === 'video-stream' || componentType === 'webrtc-guest');
}

export function normalizeSceneInstantNumericId(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : null;
}

export function normalizeSceneInstantTimestamp(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

export function normalizeSceneInstantAssetId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function buildSceneInstantPlaybackToken(
  sceneId: number | null,
  mediaAssetId: string | null,
  instantId: number | null,
  audioUrl: string,
  timestamp: string
): string {
  return `${sceneId ?? 'none'}|${mediaAssetId ?? instantId ?? 'none'}|${audioUrl.trim()}|${timestamp || 'none'}`;
}
