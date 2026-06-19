import type {
  BroadcastSettings,
  MixerChannelSetting,
  ProgramAudioMeterLevels,
  ProgramSongPlaybackState,
  SceneInstantPlaybackState,
  ProgramState,
  Scene,
  ProgramUpdateTopic,
  MixerTakeChannelKey,
  MixerTakePresetSide,
  MixerTakeApplyingMap,
  MixerTakeTimerMap,
  MixerTakeRunIdMap,
  MixerTakePresetDbMap,
  ComponentPropsMap
} from '../models/broadcast';
import { dbToFader, faderToDb, faderToGain } from './audioTaper';

export const SONG_PLAYBACK_MAX_BACKWARD_DRIFT_MS = 450;
export const AUDIO_METER_UI_EPSILON = 0.0075;
export const TAKE_VOLUME_PRESET_MIN_DB = -80;
export const TAKE_VOLUME_PRESET_MAX_DB = 12;
export const TAKE_VOLUME_PRESET_FADE_STEP_MIN_MS = 220;

export const INSTANT_PLAYBACK_SWEEP_ANIMATION = 'alcantaraInstantPlaybackSweep';
export const INSTANT_PLAYBACK_PULSE_ANIMATION = 'alcantaraInstantPlaybackPulse';
export const SONG_PROGRESS_FILL_ANIMATION = 'alcantaraSongProgressFill';
export const INSTANT_SHORTCUT_KEYS = 'qwertyuiopasdfghjklzxcvbnm';

export const DEFAULT_MIXER_TAKE_PRESETS_DB: MixerTakePresetDbMap = {
  song: { aDb: -15, bDb: -30 },
  stream: { aDb: -15, bDb: -30 },
  instants: { aDb: -15, bDb: -30 },
  sceneInstant: { aDb: -15, bDb: -30 },
  main: { aDb: -15, bDb: -30 }
};
export const MIXER_TAKE_CHANNELS: MixerTakeChannelKey[] = ['song', 'stream', 'instants', 'sceneInstant', 'main'];
export const DEFAULT_MIXER_TAKE_APPLYING: MixerTakeApplyingMap = {
  song: false, stream: false, instants: false, sceneInstant: false, main: false
};
export const DEFAULT_MIXER_TAKE_TIMERS: MixerTakeTimerMap = {
  song: null, stream: null, instants: null, sceneInstant: null, main: null
};
export const DEFAULT_MIXER_TAKE_RUN_IDS: MixerTakeRunIdMap = {
  song: 0, stream: 0, instants: 0, sceneInstant: 0, main: 0
};

export const FIFTHBELL_AVAILABLE_WEATHER_CITIES = [
  'New York', 'San Juan', 'Los Angeles', 'Honolulu', 'Mexico City', 'Havana',
  'London', 'Paris', 'Berlin', 'Rome', 'Madrid', 'Athens', 'Santiago',
  'Buenos Aires', 'Rio', 'Lima', 'Caracas', 'Bogotá', 'Tokyo', 'Seoul',
  'Shanghai', 'Hong Kong', 'Bangkok', 'Jakarta'
] as const;

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName;
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}

export function getInstantShortcutLetter(index: number): string | null {
  if (index < 0 || index >= INSTANT_SHORTCUT_KEYS.length) return null;
  return INSTANT_SHORTCUT_KEYS[index].toUpperCase();
}

export function normalizeMasterVolume(value: unknown, fallback: number = 1): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(1, value));
  return fallback;
}

export function normalizeTakeVolumePresetDb(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(TAKE_VOLUME_PRESET_MIN_DB, Math.min(TAKE_VOLUME_PRESET_MAX_DB, numeric));
}

export function normalizeTakeVolumeFadeMs(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(20000, Math.round(numeric)));
}

export function normalizeMixerToggle(value: unknown, fallback: boolean = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function defaultMixerChannelsFromScalars(source: {
  songMasterVolume: number; instantMasterVolume: number;
  sceneInstantMasterVolume: number; streamMasterVolume: number;
  songMuted: boolean; instantMuted: boolean;
  sceneInstantMuted: boolean; streamMuted: boolean;
  songSolo: boolean; instantSolo: boolean;
  sceneInstantSolo: boolean; streamSolo: boolean;
}): MixerChannelSetting[] {
  return [
    { id: 'song', name: 'Song', volume: source.songMasterVolume, muted: source.songMuted, solo: source.songSolo },
    { id: 'stream', name: 'Stream', volume: source.streamMasterVolume, muted: source.streamMuted, solo: source.streamSolo },
    { id: 'instants', name: 'Instants', volume: source.instantMasterVolume, muted: source.instantMuted, solo: source.instantSolo },
    { id: 'sceneInstant', name: 'Scene Instant', volume: source.sceneInstantMasterVolume, muted: source.sceneInstantMuted, solo: source.sceneInstantSolo }
  ];
}

export function normalizeMixerChannelsPayload(value: unknown, fallbackChannels: MixerChannelSetting[]): MixerChannelSetting[] {
  if (!Array.isArray(value)) return fallbackChannels;
  const byId = new Map<string, MixerChannelSetting>();
  for (const fc of fallbackChannels) byId.set(fc.id, { ...fc });
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id) continue;
    const prev = byId.get(id);
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : (prev?.name ?? id);
    byId.set(id, {
      id, name,
      volume: normalizeMasterVolume(record.volume, prev?.volume ?? 1),
      muted: normalizeMixerToggle(record.muted, prev?.muted ?? false),
      solo: normalizeMixerToggle(record.solo, prev?.solo ?? false)
    });
  }
  return [...byId.values()];
}

export function getMixerChannelById(channels: MixerChannelSetting[], channelId: string): MixerChannelSetting {
  return channels.find(c => c.id === channelId) ?? { id: channelId, name: channelId, volume: 1, muted: false, solo: false };
}

export function normalizeBroadcastSettingsPayload(value: unknown): BroadcastSettings {
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
  const mixerChannels = normalizeMixerChannelsPayload(record.mixerChannels, defaultMixerChannelsFromScalars(scalarFallback));
  const songChannel = getMixerChannelById(mixerChannels, 'song');
  const streamChannel = getMixerChannelById(mixerChannels, 'stream');
  const instantsChannel = getMixerChannelById(mixerChannels, 'instants');
  const sceneInstantChannel = getMixerChannelById(mixerChannels, 'sceneInstant');
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

export function withNormalizedMixerChannels(value: BroadcastSettings): BroadcastSettings {
  const existing = normalizeMixerChannelsPayload(value.mixerChannels, defaultMixerChannelsFromScalars(value));
  const byId = new Map(existing.map(c => [c.id, c] as const));
  for (const nc of defaultMixerChannelsFromScalars(value)) byId.set(nc.id, nc);
  return { ...value, mixerChannels: [...byId.values()] };
}

export function normalizeAudioMeterLevel(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function createEmptyMeterChannel() {
  return { vu: 0, peak: 0, peakHold: 0 };
}

export function normalizeProgramMeterChannel(value: unknown): { vu: number; peak: number; peakHold: number } {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = normalizeAudioMeterLevel(value);
    return { vu: n, peak: n, peakHold: n };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return createEmptyMeterChannel();
  const r = value as Record<string, unknown>;
  const vu = normalizeAudioMeterLevel(r.vu ?? r.level);
  const peak = Math.max(vu, normalizeAudioMeterLevel(r.peak ?? vu));
  const peakHold = Math.max(peak, normalizeAudioMeterLevel(r.peakHold ?? peak));
  return { vu, peak, peakHold };
}

export function normalizeProgramAudioMeter(value: unknown): ProgramAudioMeterLevels {
  if (!value || typeof value !== 'object') {
    return { song: createEmptyMeterChannel(), instants: createEmptyMeterChannel(), sceneInstant: createEmptyMeterChannel(), main: createEmptyMeterChannel(), updatedAt: new Date(0).toISOString() };
  }
  const r = value as Record<string, unknown>;
  return {
    song: normalizeProgramMeterChannel(r.song),
    instants: normalizeProgramMeterChannel(r.instants),
    sceneInstant: normalizeProgramMeterChannel(r.sceneInstant),
    main: normalizeProgramMeterChannel(r.main),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date().toISOString()
  };
}

export function normalizeProgramSongPlayback(value: unknown): ProgramSongPlaybackState {
  if (!value || typeof value !== 'object') {
    return { token: '', audioUrl: '', progress: 0, currentTimeMs: 0, durationMs: null, isPlaying: false, updatedAt: new Date(0).toISOString() };
  }
  const r = value as Record<string, unknown>;
  const durationMs = typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs > 0 ? Math.round(r.durationMs) : null;
  let currentTimeMs = typeof r.currentTimeMs === 'number' && Number.isFinite(r.currentTimeMs) ? Math.max(0, Math.round(r.currentTimeMs)) : 0;
  if (durationMs !== null) currentTimeMs = Math.min(currentTimeMs, durationMs);
  return {
    token: typeof r.token === 'string' ? r.token : '',
    audioUrl: typeof r.audioUrl === 'string' ? r.audioUrl : '',
    progress: normalizeAudioMeterLevel(r.progress),
    currentTimeMs, durationMs,
    isPlaying: Boolean(r.isPlaying),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date().toISOString()
  };
}

export function normalizeSceneInstantPlayback(value: unknown): SceneInstantPlaybackState {
  if (!value || typeof value !== 'object') {
    return { sceneId: null, instantId: null, instantName: '', isPlaying: false, updatedAt: new Date(0).toISOString() };
  }
  const r = value as Record<string, unknown>;
  const instant = r.instant && typeof r.instant === 'object' && !Array.isArray(r.instant) ? (r.instant as Record<string, unknown>) : null;
  return {
    sceneId: normalizeSceneInstantId(r.sceneId),
    instantId: normalizeSceneInstantId(r.instantId ?? instant?.id),
    instantName: typeof instant?.name === 'string' ? instant.name : '',
    isPlaying: Boolean(r.isPlaying),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date().toISOString()
  };
}

export function normalizeUpdateVersion(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  const normalized = Math.floor(numeric);
  return normalized < 0 ? null : normalized;
}

export function resolveControlUpdateTopicFromType(type: unknown): ProgramUpdateTopic | null {
  if (typeof type !== 'string') return null;
  switch (type) {
    case 'program_state_snapshot': case 'scene_change': case 'scene_staged': case 'scene_update': case 'scene_cleared': case 'program_scenes_changed': case 'program_media_groups_changed': return 'state';
    case 'audio_bus_snapshot': case 'audio_bus_update': return 'audioBus';
    case 'audio_meter_update': return 'audioMeter';
    case 'song_playback_update': case 'song_off_air': return 'songPlayback';
    case 'scene_instant_state': case 'scene_instant_take': case 'scene_instant_stop': return 'sceneInstant';
    default: return null;
  }
}

export function readControlUpdateVersion(topic: ProgramUpdateTopic, payload: unknown): number | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const topLevel = normalizeUpdateVersion(record.version);
  if (topLevel !== null) return topLevel;
  switch (topic) {
    case 'state': return normalizeUpdateVersion((record.state as Record<string, unknown> | undefined)?.version ?? record.stateVersion);
    case 'audioBus': return normalizeUpdateVersion((record.settings as Record<string, unknown> | undefined)?.version ?? record.audioBusVersion);
    case 'audioMeter': return normalizeUpdateVersion((record.levels as Record<string, unknown> | undefined)?.version ?? record.audioMeterVersion);
    case 'songPlayback': return normalizeUpdateVersion((record.playback as Record<string, unknown> | undefined)?.version ?? record.songPlaybackVersion);
    case 'sceneInstant': return normalizeUpdateVersion((record.playback as Record<string, unknown> | undefined)?.version ?? record.sceneInstantVersion);
    default: return null;
  }
}

export function reconcileProgramSongPlayback(prev: ProgramSongPlaybackState, next: ProgramSongPlaybackState): ProgramSongPlaybackState {
  if (prev.token && next.token && prev.token === next.token && prev.audioUrl === next.audioUrl && prev.isPlaying) {
    if (prev.currentTimeMs - next.currentTimeMs > SONG_PLAYBACK_MAX_BACKWARD_DRIFT_MS) return prev;
  }
  return next;
}

export function reconcileProgramAudioMeter(prev: ProgramAudioMeterLevels, next: ProgramAudioMeterLevels): ProgramAudioMeterLevels {
  const deltas = [
    Math.abs(prev.song.vu - next.song.vu), Math.abs(prev.song.peak - next.song.peak), Math.abs(prev.song.peakHold - next.song.peakHold),
    Math.abs(prev.instants.vu - next.instants.vu), Math.abs(prev.instants.peak - next.instants.peak), Math.abs(prev.instants.peakHold - next.instants.peakHold),
    Math.abs(prev.sceneInstant.vu - next.sceneInstant.vu), Math.abs(prev.sceneInstant.peak - next.sceneInstant.peak), Math.abs(prev.sceneInstant.peakHold - next.sceneInstant.peakHold),
    Math.abs(prev.main.vu - next.main.vu), Math.abs(prev.main.peak - next.main.peak), Math.abs(prev.main.peakHold - next.main.peakHold)
  ];
  if (deltas.every(d => d < AUDIO_METER_UI_EPSILON)) return prev;
  return next;
}

export function normalizeProgramState(value: unknown): ProgramState | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<ProgramState> & { activeScene?: unknown; stagedScene?: unknown };
  return {
    ...(record as ProgramState),
    scenes: Array.isArray(record.scenes) ? record.scenes : [],
    mediaGroups: Array.isArray(record.mediaGroups) ? record.mediaGroups : [],
    activeSceneId: typeof record.activeSceneId === 'number' ? record.activeSceneId : null,
    stagedSceneId: typeof record.stagedSceneId === 'number' ? record.stagedSceneId : null,
    activeScene: record.activeScene && typeof record.activeScene === 'object' ? (record.activeScene as Scene) : null,
    stagedScene: record.stagedScene && typeof record.stagedScene === 'object' ? (record.stagedScene as Scene) : null
  };
}

export function meterLevelToFill(value: unknown): number {
  return Math.max(0, Math.min(1, Math.pow(normalizeAudioMeterLevel(value), 0.6)));
}

export function formatMixerLevelInputValue(value: number): string {
  const db = faderToDb(value);
  return Number.isFinite(db) ? db.toFixed(1) : '-inf';
}

export function parseMixerLevelInputToFader(rawValue: string, fallbackValue: number): number {
  const normalized = rawValue.trim().toLowerCase();
  if (!normalized) return fallbackValue;
  if (['-inf', '-infinity', '-∞'].includes(normalized)) return 0;
  const parsedDb = Number.parseFloat(normalized.replace(/db$/i, '').trim());
  return Number.isFinite(parsedDb) ? dbToFader(parsedDb) : fallbackValue;
}

export function normalizeSlideshowImageList(value: unknown): string[] {
  const collected: string[] = [];
  const append = (raw: string) => {
    raw.split(/[\n,]/g).map(e => e.trim()).filter(Boolean).forEach(e => collected.push(e));
  };
  if (Array.isArray(value)) {
    value.forEach(e => { if (typeof e === 'string') append(e); });
  } else if (typeof value === 'string') {
    append(value);
  }
  const seen = new Set<string>();
  return collected.filter(e => { if (seen.has(e)) return false; seen.add(e); return true; });
}

export function normalizeSlideshowMediaGroupId(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 && Number.isInteger(numeric) ? numeric : null;
}

export function normalizeSceneInstantId(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 && Number.isInteger(numeric) ? numeric : null;
}

export function parseSceneMetadata(metadata: string | null): ComponentPropsMap {
  try {
    const parsed = metadata ? JSON.parse(metadata) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  return {};
}

export function withIndependentProgramClockMetadata(metadata: ComponentPropsMap): ComponentPropsMap {
  return metadata;
}

export function formatTakePresetDbInputValue(value: number): string {
  if (!Number.isFinite(value)) return '-15.0';
  return value.toFixed(1);
}
