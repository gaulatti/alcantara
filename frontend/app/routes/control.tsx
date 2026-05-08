import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Accordion, Button, Checkbox, FileInput, IconButton, Input, Panel, PanelLayout, Select, Sheet, Switch, Textarea } from '@gaulatti/bleecker';
import { Clock, GripVertical, Music2, Play, Plus, Repeat2, SkipBack, SkipForward, Square, ZapOff } from 'lucide-react';
import type { Route } from './+types/control';
import { apiUrl } from '../utils/apiBaseUrl';
import { OVERLAY_COMPONENTS, hasConfigurableSceneAttributes, getDefaultPropsForComponent as getStaticDefaultProps } from '../models/components';
import { useSSE } from '../hooks/useSSE';
import { uploadFileToMediaBucket } from '../services/uploads';
import { useGlobalProgramId } from '../utils/globalProgram';
import { useGlobalTransitionId } from '../utils/globalTransition';
import { getTimezonesSortedByOffset, getTimezoneOptionLabel } from '../utils/timezones';
import { getProgramRealtimeSocketUrl } from '../utils/programRealtimeSocket';
import {
  countSequenceLeafItems,
  createToniChyronSequence,
  createToniChyronSequenceItem,
  getToniChyronContentMode,
  getToniChyronSequenceSelectedItemId,
  normalizeToniChyronSequence,
  type ToniChyronSequence,
  type ToniChyronSequenceItem
} from '../utils/toniChyronSequence';
import {
  createProgramSongSequence,
  createProgramSongSequenceItem,
  createProgramTextSequence,
  createProgramTextSequenceItem,
  getProgramSongSequenceSelectedItemId,
  getProgramTextSequenceSelectedItemId,
  normalizeProgramSongSequence,
  normalizeProgramTextSequence,
  resolveProgramSongLeaf,
  type ProgramSongSequence,
  type ProgramSongSequenceItem,
  type ProgramTextSequence,
  type ProgramTextSequenceItem
} from '../utils/programSequence';
import { dbToFader, faderToDb, faderToGain } from '../utils/audioTaper';

interface Layout {
  id: number;
  name: string;
  componentType: string;
  settings: string;
}

interface Scene {
  id: number;
  name: string;
  layoutId: number;
  layout: Layout;
  chyronText: string | null;
  metadata: string | null;
}

interface ComponentType {
  type: string;
  name: string;
  description: string;
}

interface ProgramSceneEntry {
  id: number;
  sceneId: number;
  position: number;
  scene: Scene;
}

interface ProgramMediaGroupEntry {
  id: number;
  mediaGroupId: number;
  position: number;
  mediaGroup: MediaGroup;
}

interface ProgramState {
  id: number;
  programId: string;
  activeSceneId: number | null;
  activeScene?: Scene | null;
  stagedSceneId?: number | null;
  stagedScene?: Scene | null;
  scenes: ProgramSceneEntry[];
  mediaGroups: ProgramMediaGroupEntry[];
}

interface InstantItem {
  id: number;
  name: string;
  audioUrl: string;
  volume: number;
  enabled: boolean;
  position: number;
}

interface InstantPlaybackState {
  startedAtMs: number;
  endsAtMs: number | null;
}

interface SongCatalogItem {
  id: number;
  artist: string;
  title: string;
  audioUrl: string;
  coverUrl: string | null;
  durationMs: number | null;
  earoneSongId: string | null;
  earoneRank: string | null;
  earoneSpins: string | null;
  enabled: boolean;
}

interface MediaItem {
  id: number;
  name: string;
  imageUrl: string;
}

interface MediaGroupItem {
  id: number;
  mediaGroupId: number;
  mediaId: number;
  position: number;
  media: MediaItem;
}

interface MediaGroup {
  id: number;
  name: string;
  description: string | null;
  items: MediaGroupItem[];
}

interface ProgramAudioBusSettings {
  songSequence: unknown | null;
  mixerSettings?: unknown | null;
}

interface BroadcastSettings {
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
  mixerChannels: MixerChannelSetting[];
}

interface MixerChannelSetting {
  id: string;
  name: string;
  volume: number;
  muted: boolean;
  solo: boolean;
}

interface ProgramAudioMeterLevels {
  song: {
    vu: number;
    peak: number;
    peakHold: number;
  };
  instants: {
    vu: number;
    peak: number;
    peakHold: number;
  };
  sceneInstant: {
    vu: number;
    peak: number;
    peakHold: number;
  };
  main: {
    vu: number;
    peak: number;
    peakHold: number;
  };
  updatedAt: string;
}

interface SceneInstantPlaybackState {
  sceneId: number | null;
  instantId: number | null;
  instantName: string;
  isPlaying: boolean;
  updatedAt: string;
}

interface ProgramSongPlaybackState {
  token: string;
  audioUrl: string;
  progress: number;
  currentTimeMs: number;
  durationMs: number | null;
  isPlaying: boolean;
  updatedAt: string;
}
const SONG_PLAYBACK_MAX_BACKWARD_DRIFT_MS = 450;
const AUDIO_METER_UI_EPSILON = 0.0075;
const TAKE_VOLUME_PRESET_MIN_DB = -80;
const TAKE_VOLUME_PRESET_MAX_DB = 12;
const TAKE_VOLUME_PRESET_FADE_STEP_MIN_MS = 220;

const INSTANT_PLAYBACK_SWEEP_ANIMATION = 'alcantaraInstantPlaybackSweep';
const INSTANT_PLAYBACK_PULSE_ANIMATION = 'alcantaraInstantPlaybackPulse';
const SONG_PROGRESS_FILL_ANIMATION = 'alcantaraSongProgressFill';
const INSTANT_SHORTCUT_KEYS = 'qwertyuiopasdfghjklzxcvbnm';

type ComponentPropsMap = Record<string, any>;
type SceneAttributeSavePayload = {
  sceneId: number;
  props: ComponentPropsMap;
  signature: string;
  revision: number;
};
type ProgramUpdateTopic = 'state' | 'audioBus' | 'audioMeter' | 'songPlayback' | 'sceneInstant';
type MixerTakeChannelKey = 'song' | 'stream' | 'instants' | 'sceneInstant' | 'main';
type MixerTakePresetSide = 'a' | 'b';
type MixerTakePresetDbMap = Record<
  MixerTakeChannelKey,
  {
    aDb: number;
    bDb: number;
  }
>;
type MixerTakeSideMap = Record<MixerTakeChannelKey, MixerTakePresetSide>;
type MixerTakeApplyingMap = Record<MixerTakeChannelKey, boolean>;
type MixerTakeTimerMap = Record<MixerTakeChannelKey, number | null>;
type MixerTakeRunIdMap = Record<MixerTakeChannelKey, number>;
const DEFAULT_MIXER_TAKE_PRESETS_DB: MixerTakePresetDbMap = {
  song: { aDb: -15, bDb: -30 },
  stream: { aDb: -15, bDb: -30 },
  instants: { aDb: -15, bDb: -30 },
  sceneInstant: { aDb: -15, bDb: -30 },
  main: { aDb: -15, bDb: -30 }
};
const MIXER_TAKE_CHANNELS: MixerTakeChannelKey[] = ['song', 'stream', 'instants', 'sceneInstant', 'main'];
const DEFAULT_MIXER_TAKE_TARGET_SIDE: MixerTakeSideMap = {
  song: 'a',
  stream: 'a',
  instants: 'a',
  sceneInstant: 'a',
  main: 'a'
};
const DEFAULT_MIXER_TAKE_APPLYING: MixerTakeApplyingMap = {
  song: false,
  stream: false,
  instants: false,
  sceneInstant: false,
  main: false
};
const DEFAULT_MIXER_TAKE_TIMERS: MixerTakeTimerMap = {
  song: null,
  stream: null,
  instants: null,
  sceneInstant: null,
  main: null
};
const DEFAULT_MIXER_TAKE_RUN_IDS: MixerTakeRunIdMap = {
  song: 0,
  stream: 0,
  instants: 0,
  sceneInstant: 0,
  main: 0
};
const FIFTHBELL_AVAILABLE_WEATHER_CITIES = [
  'New York',
  'San Juan',
  'Los Angeles',
  'Honolulu',
  'Mexico City',
  'Havana',
  'London',
  'Paris',
  'Berlin',
  'Rome',
  'Madrid',
  'Athens',
  'Santiago',
  'Buenos Aires',
  'Rio',
  'Lima',
  'Caracas',
  'Bogotá',
  'Tokyo',
  'Seoul',
  'Shanghai',
  'Hong Kong',
  'Bangkok',
  'Jakarta'
] as const;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tagName = target.tagName;
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}

function getInstantShortcutLetter(index: number): string | null {
  if (index < 0 || index >= INSTANT_SHORTCUT_KEYS.length) {
    return null;
  }

  return INSTANT_SHORTCUT_KEYS[index].toUpperCase();
}

function normalizeMasterVolume(value: unknown, fallback: number = 1): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  return fallback;
}

function normalizeTakeVolumePresetDb(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(TAKE_VOLUME_PRESET_MIN_DB, Math.min(TAKE_VOLUME_PRESET_MAX_DB, numeric));
}

function normalizeTakeVolumeFadeMs(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.min(20000, Math.round(numeric)));
}

function normalizeMixerToggle(value: unknown, fallback: boolean = false): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  return fallback;
}

function defaultMixerChannelsFromScalars(source: {
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
}): MixerChannelSetting[] {
  return [
    {
      id: 'song',
      name: 'Song',
      volume: source.songMasterVolume,
      muted: source.songMuted,
      solo: source.songSolo
    },
    {
      id: 'stream',
      name: 'Stream',
      volume: source.streamMasterVolume,
      muted: source.streamMuted,
      solo: source.streamSolo
    },
    {
      id: 'instants',
      name: 'Instants',
      volume: source.instantMasterVolume,
      muted: source.instantMuted,
      solo: source.instantSolo
    },
    {
      id: 'sceneInstant',
      name: 'Scene Instant',
      volume: source.sceneInstantMasterVolume,
      muted: source.sceneInstantMuted,
      solo: source.sceneInstantSolo
    }
  ];
}

function normalizeMixerChannelsPayload(value: unknown, fallbackChannels: MixerChannelSetting[]): MixerChannelSetting[] {
  if (!Array.isArray(value)) {
    return fallbackChannels;
  }

  const byId = new Map<string, MixerChannelSetting>();
  for (const fallbackChannel of fallbackChannels) {
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

function getMixerChannelById(channels: MixerChannelSetting[], channelId: string): MixerChannelSetting {
  const matched = channels.find((channel) => channel.id === channelId);
  if (matched) {
    return matched;
  }
  return {
    id: channelId,
    name: channelId,
    volume: 1,
    muted: false,
    solo: false
  };
}

function normalizeBroadcastSettingsPayload(value: unknown): BroadcastSettings {
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

function withNormalizedMixerChannels(value: BroadcastSettings): BroadcastSettings {
  const fallbackChannels = defaultMixerChannelsFromScalars(value);
  const existingChannels = normalizeMixerChannelsPayload(value.mixerChannels, fallbackChannels);
  const byId = new Map(existingChannels.map((channel) => [channel.id, channel] as const));
  const normalizedDefaults = defaultMixerChannelsFromScalars(value);
  for (const normalizedChannel of normalizedDefaults) {
    byId.set(normalizedChannel.id, normalizedChannel);
  }
  const mixerChannels = [...byId.values()];
  return {
    ...value,
    mixerChannels
  };
}

function normalizeAudioMeterLevel(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  return 0;
}

function createEmptyMeterChannel() {
  return {
    vu: 0,
    peak: 0,
    peakHold: 0
  };
}

function normalizeProgramMeterChannel(value: unknown): { vu: number; peak: number; peakHold: number } {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = normalizeAudioMeterLevel(value);
    return {
      vu: normalized,
      peak: normalized,
      peakHold: normalized
    };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createEmptyMeterChannel();
  }

  const record = value as Record<string, unknown>;
  const vu = normalizeAudioMeterLevel(record.vu ?? record.level);
  const peak = Math.max(vu, normalizeAudioMeterLevel(record.peak ?? vu));
  const peakHold = Math.max(peak, normalizeAudioMeterLevel(record.peakHold ?? peak));
  return {
    vu,
    peak,
    peakHold
  };
}

function normalizeProgramAudioMeter(value: unknown): ProgramAudioMeterLevels {
  if (!value || typeof value !== 'object') {
    return {
      song: createEmptyMeterChannel(),
      instants: createEmptyMeterChannel(),
      sceneInstant: createEmptyMeterChannel(),
      main: createEmptyMeterChannel(),
      updatedAt: new Date(0).toISOString()
    };
  }

  const record = value as Record<string, unknown>;
  return {
    song: normalizeProgramMeterChannel(record.song),
    instants: normalizeProgramMeterChannel(record.instants),
    sceneInstant: normalizeProgramMeterChannel(record.sceneInstant),
    main: normalizeProgramMeterChannel(record.main),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString()
  };
}

function normalizeProgramSongPlayback(value: unknown): ProgramSongPlaybackState {
  if (!value || typeof value !== 'object') {
    return {
      token: '',
      audioUrl: '',
      progress: 0,
      currentTimeMs: 0,
      durationMs: null,
      isPlaying: false,
      updatedAt: new Date(0).toISOString()
    };
  }

  const record = value as Record<string, unknown>;
  const durationMs =
    typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs > 0 ? Math.round(record.durationMs) : null;
  let currentTimeMs = typeof record.currentTimeMs === 'number' && Number.isFinite(record.currentTimeMs) ? Math.max(0, Math.round(record.currentTimeMs)) : 0;

  if (durationMs !== null) {
    currentTimeMs = Math.min(currentTimeMs, durationMs);
  }

  return {
    token: typeof record.token === 'string' ? record.token : '',
    audioUrl: typeof record.audioUrl === 'string' ? record.audioUrl : '',
    progress: normalizeAudioMeterLevel(record.progress),
    currentTimeMs,
    durationMs,
    isPlaying: Boolean(record.isPlaying),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString()
  };
}

function normalizeSceneInstantPlayback(value: unknown): SceneInstantPlaybackState {
  if (!value || typeof value !== 'object') {
    return {
      sceneId: null,
      instantId: null,
      instantName: '',
      isPlaying: false,
      updatedAt: new Date(0).toISOString()
    };
  }

  const record = value as Record<string, unknown>;
  const instant = record.instant && typeof record.instant === 'object' && !Array.isArray(record.instant) ? (record.instant as Record<string, unknown>) : null;

  return {
    sceneId: normalizeSceneInstantId(record.sceneId),
    instantId: normalizeSceneInstantId(record.instantId ?? instant?.id),
    instantName: typeof instant?.name === 'string' ? instant.name : '',
    isPlaying: Boolean(record.isPlaying),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString()
  };
}

function normalizeUpdateVersion(value: unknown): number | null {
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

function resolveControlUpdateTopicFromType(type: unknown): ProgramUpdateTopic | null {
  if (typeof type !== 'string') {
    return null;
  }

  switch (type) {
    case 'program_state_snapshot':
    case 'scene_change':
    case 'scene_staged':
    case 'scene_update':
    case 'scene_cleared':
    case 'program_scenes_changed':
    case 'program_media_groups_changed':
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
    default:
      return null;
  }
}

function readControlUpdateVersion(topic: ProgramUpdateTopic, payload: unknown): number | null {
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
    default:
      return null;
  }
}

function reconcileProgramSongPlayback(previous: ProgramSongPlaybackState, next: ProgramSongPlaybackState): ProgramSongPlaybackState {
  if (previous.token && next.token && previous.token === next.token && previous.audioUrl === next.audioUrl && previous.isPlaying) {
    const backwardDriftMs = previous.currentTimeMs - next.currentTimeMs;
    if (backwardDriftMs > SONG_PLAYBACK_MAX_BACKWARD_DRIFT_MS) {
      return previous;
    }
  }

  return next;
}

function reconcileProgramAudioMeter(previous: ProgramAudioMeterLevels, next: ProgramAudioMeterLevels): ProgramAudioMeterLevels {
  const deltas = [
    Math.abs(previous.song.vu - next.song.vu),
    Math.abs(previous.song.peak - next.song.peak),
    Math.abs(previous.song.peakHold - next.song.peakHold),
    Math.abs(previous.instants.vu - next.instants.vu),
    Math.abs(previous.instants.peak - next.instants.peak),
    Math.abs(previous.instants.peakHold - next.instants.peakHold),
    Math.abs(previous.sceneInstant.vu - next.sceneInstant.vu),
    Math.abs(previous.sceneInstant.peak - next.sceneInstant.peak),
    Math.abs(previous.sceneInstant.peakHold - next.sceneInstant.peakHold),
    Math.abs(previous.main.vu - next.main.vu),
    Math.abs(previous.main.peak - next.main.peak),
    Math.abs(previous.main.peakHold - next.main.peakHold)
  ];
  if (deltas.every((delta) => delta < AUDIO_METER_UI_EPSILON)) {
    return previous;
  }
  return next;
}

function normalizeProgramState(value: unknown): ProgramState | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Partial<ProgramState> & {
    activeScene?: unknown;
    stagedScene?: unknown;
  };
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

function meterLevelToFill(value: unknown): number {
  const normalized = normalizeAudioMeterLevel(value);
  return Math.max(0, Math.min(1, Math.pow(normalized, 0.6)));
}

function formatMixerLevelInputValue(value: number): string {
  const db = faderToDb(value);
  if (!Number.isFinite(db)) {
    return '-inf';
  }
  return db.toFixed(1);
}

function parseMixerLevelInputToFader(rawValue: string, fallbackValue: number): number {
  const normalized = rawValue.trim().toLowerCase();
  if (!normalized) {
    return fallbackValue;
  }

  if (normalized === '-inf' || normalized === '-infinity' || normalized === '-∞') {
    return 0;
  }

  const withoutUnit = normalized.replace(/db$/i, '').trim();
  const parsedDb = Number.parseFloat(withoutUnit);
  if (!Number.isFinite(parsedDb)) {
    return fallbackValue;
  }

  return dbToFader(parsedDb);
}

function normalizeSlideshowImageList(value: unknown): string[] {
  const collected: string[] = [];
  const appendFromString = (raw: string) => {
    raw
      .split(/[\n,]/g)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach((entry) => {
        collected.push(entry);
      });
  };

  if (Array.isArray(value)) {
    value.forEach((entry) => {
      if (typeof entry === 'string') {
        appendFromString(entry);
      }
    });
  } else if (typeof value === 'string') {
    appendFromString(value);
  }

  const seen = new Set<string>();
  return collected.filter((entry) => {
    if (seen.has(entry)) {
      return false;
    }
    seen.add(entry);
    return true;
  });
}

function normalizeSlideshowMediaGroupId(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || !Number.isInteger(numeric)) {
    return null;
  }
  return numeric;
}

function normalizeSceneInstantId(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || !Number.isInteger(numeric)) {
    return null;
  }
  return numeric;
}

function SlideshowEditorFields({
  componentType,
  props,
  updateProp,
  mediaGroups,
  isLoadingMediaGroups
}: {
  componentType: string;
  props: any;
  updateProp: (componentType: string, propName: string, value: any) => void;
  mediaGroups: MediaGroup[];
  isLoadingMediaGroups: boolean;
}) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const images = normalizeSlideshowImageList(props.images);
  const asBoolean = (value: unknown, fallback: boolean) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
    }
    return fallback;
  };
  const setImages = (nextImages: string[]) => {
    updateProp(componentType, 'images', nextImages);
  };
  const selectedMediaGroupId = normalizeSlideshowMediaGroupId(props.mediaGroupId);
  const selectedMediaGroup = selectedMediaGroupId !== null ? (mediaGroups.find((group) => group.id === selectedMediaGroupId) ?? null) : null;
  const mediaGroupImages = selectedMediaGroup ? selectedMediaGroup.items.map((item) => item.media.imageUrl).filter(Boolean) : [];
  const usesMediaGroup = selectedMediaGroupId !== null;

  const uploadImages = async (files: File[]) => {
    if (!files.length) {
      return;
    }

    setUploadError('');
    setIsUploading(true);
    const nextImages = [...images];
    let failedUploads = 0;

    try {
      for (const file of files) {
        try {
          const upload = await uploadFileToMediaBucket('artwork', file);
          nextImages.push(upload.url);
        } catch (error) {
          failedUploads += 1;
          console.error('Failed to upload slideshow image:', error);
        }
      }

      setImages(nextImages);
      if (failedUploads > 0) {
        setUploadError(
          failedUploads === files.length ? 'Failed to upload selected image files.' : `Uploaded ${files.length - failedUploads} of ${files.length} images.`
        );
      }
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className='space-y-3'>
      <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3'>
        <label className='text-sm text-text-primary'>
          <span className='block text-xs text-text-secondary mb-1'>Interval (ms)</span>
          <Input
            type='number'
            min={1000}
            step={100}
            value={typeof props.intervalMs === 'number' ? props.intervalMs : 5000}
            onChange={(event) => updateProp(componentType, 'intervalMs', Math.max(1000, Number(event.target.value) || 5000))}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
          />
        </label>
        <label className='text-sm text-text-primary'>
          <span className='block text-xs text-text-secondary mb-1'>Transition (ms)</span>
          <Input
            type='number'
            min={100}
            step={50}
            value={typeof props.transitionMs === 'number' ? props.transitionMs : 900}
            onChange={(event) => updateProp(componentType, 'transitionMs', Math.max(100, Number(event.target.value) || 900))}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
          />
        </label>
        <label className='text-sm text-text-primary'>
          <span className='block text-xs text-text-secondary mb-1'>Fit Mode</span>
          <Select
            value={props.fitMode === 'contain' ? 'contain' : 'cover'}
            onChange={(value) => updateProp(componentType, 'fitMode', value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            options={[
              { value: 'cover', label: 'Cover' },
              { value: 'contain', label: 'Contain' }
            ]}
          />
        </label>
        <div className='flex flex-col justify-end gap-2 pb-1'>
          <label className='flex items-center gap-2 text-sm text-text-primary'>
            <Input
              type='checkbox'
              checked={asBoolean(props.shuffle, false)}
              onChange={(event) => updateProp(componentType, 'shuffle', event.target.checked)}
              className='h-4 w-4'
            />
            Shuffle
          </label>
          <label className='flex items-center gap-2 text-sm text-text-primary'>
            <Input
              type='checkbox'
              checked={asBoolean(props.kenBurns, true)}
              onChange={(event) => updateProp(componentType, 'kenBurns', event.target.checked)}
              className='h-4 w-4'
            />
            Ken Burns Motion
          </label>
        </div>
      </div>

      <div className='space-y-2'>
        <label className='block text-xs text-text-secondary'>Media Group Source</label>
        <Select
          value={selectedMediaGroupId !== null ? String(selectedMediaGroupId) : ''}
          onChange={(value) => {
            const nextGroupId = normalizeSlideshowMediaGroupId(value);
            updateProp(componentType, 'mediaGroupId', nextGroupId);
          }}
          className='w-full rounded border border-sand/40 px-3 py-2 text-sm focus:ring-2 focus:ring-sea/50'
          options={[
            { value: '', label: 'Manual images in scene metadata' },
            ...mediaGroups.map((group) => ({
              value: String(group.id),
              label: `${group.name} (${group.items.length} images)`
            }))
          ]}
        />
        <p className='text-xs text-text-secondary'>
          {isLoadingMediaGroups
            ? 'Loading media groups...'
            : usesMediaGroup
              ? 'This slideshow now follows the selected media group.'
              : 'Tip: select a media group to reuse image sets across scenes.'}
        </p>
      </div>

      {!usesMediaGroup ? (
        <div className='space-y-2'>
          <label className='block text-xs text-text-secondary'>Upload images</label>
          <Input
            type='file'
            accept='image/*'
            multiple
            disabled={isUploading}
            onChange={(event) => {
              const files = event.target.files ? Array.from(event.target.files) : [];
              event.target.value = '';
              void uploadImages(files);
            }}
            className='block w-full text-xs text-text-secondary file:mr-3 file:rounded file:border file:border-sand/40 file:bg-dark-sand/80 file:px-2 file:py-1 file:text-xs file:font-medium file:text-text-primary hover:file:bg-sand/10'
          />
          <p className='text-xs text-text-secondary mt-1'>1920x1080 images are recommended. Upload one or many files.</p>
          {isUploading ? <p className='text-xs text-text-secondary'>Uploading image...</p> : null}
          {uploadError ? <p className='text-xs text-terracotta'>{uploadError}</p> : null}
        </div>
      ) : null}

      {usesMediaGroup ? (
        <div className='space-y-2'>
          <p className='text-xs text-text-secondary'>{selectedMediaGroup ? `Using group "${selectedMediaGroup.name}"` : 'Selected group not found.'}</p>
          {selectedMediaGroup && mediaGroupImages.length > 0 ? (
            <div className='grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2'>
              {mediaGroupImages.map((url, index) => (
                <div key={`${url}_${index}`} className='rounded border border-sand/30 bg-dark-sand/80 p-2'>
                  <img src={url} alt={`Media group image ${index + 1}`} className='h-20 w-full rounded object-cover bg-sand/10' />
                </div>
              ))}
            </div>
          ) : (
            <p className='text-xs text-text-secondary'>No images in this group yet. Add assets in the Media page.</p>
          )}
        </div>
      ) : images.length > 0 ? (
        <div className='grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2'>
          {images.map((url, index) => (
            <div key={`${url}_${index}`} className='rounded border border-sand/30 bg-dark-sand/80 p-2 space-y-2'>
              <img src={url} alt={`Slideshow ${index + 1}`} className='h-20 w-full rounded object-cover bg-sand/10' />
              <Button
                type='button'
                onClick={() => {
                  setImages(images.filter((_, imageIndex) => imageIndex !== index));
                }}
                className='w-full rounded border border-terracotta/35 px-2 py-1 text-xs font-medium text-terracotta hover:bg-terracotta/10'
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function parseSceneMetadata(metadata: string | null): ComponentPropsMap {
  try {
    const parsed = metadata ? JSON.parse(metadata) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // no-op, fallback below
  }

  return {};
}

function withIndependentProgramClockMetadata(metadata: ComponentPropsMap): ComponentPropsMap {
  if (!Object.prototype.hasOwnProperty.call(metadata, 'modoitaliano-clock')) {
    return metadata;
  }

  return {
    ...metadata,
    'modoitaliano-clock': {}
  };
}

function PanelColumn({
  children,
  grow: _grow,
  style,
  className
}: {
  children: React.ReactNode;
  grow?: boolean;
  style?: React.CSSProperties;
  className?: string;
}) {
  return (
    <div className={`flex h-full min-h-0 flex-col${className ? ` ${className}` : ''}`} style={style}>
      {children}
    </div>
  );
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Control Panel - TV Broadcast' }, { name: 'description', content: 'Control panel for TV broadcast overlay system' }];
}

export default function Control() {
  const [activeProgramId] = useGlobalProgramId();
  const [programState, setProgramState] = useState<ProgramState | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [instants, setInstants] = useState<InstantItem[]>([]);
  const [isLoadingInstants, setIsLoadingInstants] = useState(false);
  const [instantSearch, setInstantSearch] = useState('');
  const [songCatalog, setSongCatalog] = useState<SongCatalogItem[]>([]);
  const [mediaGroups, setMediaGroups] = useState<MediaGroup[]>([]);
  const [isLoadingMediaGroups, setIsLoadingMediaGroups] = useState(false);
  const [instantDurationsMs, setInstantDurationsMs] = useState<Record<number, number | null>>({});
  const [instantPlayback, setInstantPlayback] = useState<Record<number, InstantPlaybackState>>({});
  const instantDurationByUrlRef = useRef<Record<string, number | null>>({});
  const instantPlaybackTimeoutsRef = useRef<Record<number, number>>({});
  const [layouts, setLayouts] = useState<Layout[]>([]);
  const componentTypes = OVERLAY_COMPONENTS.map((c) => ({ type: c.id, name: c.name, description: c.description }));
  const [selectedScene, setSelectedScene] = useState<number | null>(null);
  const [sceneEditorProps, setSceneEditorProps] = useState<Record<string, any>>({});
  const [isSavingSceneAttributes, setIsSavingSceneAttributes] = useState(false);
  const [sceneAttributeSaveError, setSceneAttributeSaveError] = useState<string | null>(null);
  const sceneEditorAutosaveTimerRef = useRef<number | null>(null);
  const sceneEditorAutosaveSignatureRef = useRef<string>('');
  const sceneEditorDirtyRef = useRef<boolean>(false);
  const sceneEditorRevisionRef = useRef<number>(0);
  const selectedSceneRef = useRef<number | null>(null);
  const previousSelectedSceneRef = useRef<number | null>(null);
  const sceneEditorPropsRef = useRef<ComponentPropsMap>({});
  const sceneMetadataCacheRef = useRef<Record<number, ComponentPropsMap>>({});
  const pendingSceneAttributeSaveRef = useRef<SceneAttributeSavePayload | null>(null);
  const sceneAttributeSaveDrainPromiseRef = useRef<Promise<void> | null>(null);
  const sceneAttributeRetryTimerRef = useRef<number | null>(null);
  const sceneAttributeFlushKickTimerRef = useRef<number | null>(null);
  const sceneAttributeRetryDelayMsRef = useRef<number>(800);
  const [editingScene, setEditingScene] = useState<Scene | null>(null);

  const [showSceneModal, setShowSceneModal] = useState(false);
  const [newSceneName, setNewSceneName] = useState('');
  const [selectedLayoutId, setSelectedLayoutId] = useState<number | null>(null);
  const [sceneComponentProps, setSceneComponentProps] = useState<Record<string, any>>({});
  const [sceneErrors, setSceneErrors] = useState({ name: '', layout: '', props: '' });
  const [isCreatingScene, setIsCreatingScene] = useState(false);
  const [selectedTransitionId] = useGlobalTransitionId(activeProgramId);
  const [programAudioBusSettings, setProgramAudioBusSettings] = useState<ProgramAudioBusSettings>({
    songSequence: createProgramSongSequence('manual')
  });
  const [isSavingProgramAudioBus, setIsSavingProgramAudioBus] = useState(false);
  const [isPlaylistSheetOpen, setIsPlaylistSheetOpen] = useState(false);
  const [mixerLevels, setMixerLevels] = useState<BroadcastSettings>({
    mainMasterVolume: 1,
    songMasterVolume: 1,
    instantMasterVolume: 1,
    sceneInstantMasterVolume: 1,
    streamMasterVolume: 1,
    songMuted: false,
    instantMuted: false,
    sceneInstantMuted: false,
    streamMuted: false,
    songSolo: false,
    instantSolo: false,
    sceneInstantSolo: false,
    streamSolo: false,
    mixerChannels: defaultMixerChannelsFromScalars({
      songMasterVolume: 1,
      instantMasterVolume: 1,
      sceneInstantMasterVolume: 1,
      streamMasterVolume: 1,
      songMuted: false,
      instantMuted: false,
      sceneInstantMuted: false,
      streamMuted: false,
      songSolo: false,
      instantSolo: false,
      sceneInstantSolo: false,
      streamSolo: false
    })
  });
  const mixerLevelsRef = useRef<BroadcastSettings>({
    mainMasterVolume: 1,
    songMasterVolume: 1,
    instantMasterVolume: 1,
    sceneInstantMasterVolume: 1,
    streamMasterVolume: 1,
    songMuted: false,
    instantMuted: false,
    sceneInstantMuted: false,
    streamMuted: false,
    songSolo: false,
    instantSolo: false,
    sceneInstantSolo: false,
    streamSolo: false,
    mixerChannels: defaultMixerChannelsFromScalars({
      songMasterVolume: 1,
      instantMasterVolume: 1,
      sceneInstantMasterVolume: 1,
      streamMasterVolume: 1,
      songMuted: false,
      instantMuted: false,
      sceneInstantMuted: false,
      streamMuted: false,
      songSolo: false,
      instantSolo: false,
      sceneInstantSolo: false,
      streamSolo: false
    })
  });
  const [isLoadingMixerLevels, setIsLoadingMixerLevels] = useState(false);
  const [isSavingMixerLevels, setIsSavingMixerLevels] = useState(false);
  const mixerSaveTimeoutRef = useRef<number | null>(null);
  const takeVolumeFadeTimerRef = useRef<MixerTakeTimerMap>({ ...DEFAULT_MIXER_TAKE_TIMERS });
  const takeVolumeFadeRunIdRef = useRef<MixerTakeRunIdMap>({ ...DEFAULT_MIXER_TAKE_RUN_IDS });
  const [mixerTakePresetsDb, setMixerTakePresetsDb] = useState<MixerTakePresetDbMap>({ ...DEFAULT_MIXER_TAKE_PRESETS_DB });
  const [mixerTakeTargetSide, setMixerTakeTargetSide] = useState<MixerTakeSideMap>({ ...DEFAULT_MIXER_TAKE_TARGET_SIDE });
  const [takePresetFadeMs, setTakePresetFadeMs] = useState<number>(5000);
  const [isApplyingTakePresetByChannel, setIsApplyingTakePresetByChannel] = useState<MixerTakeApplyingMap>({ ...DEFAULT_MIXER_TAKE_APPLYING });
  const [programAudioMeterLevels, setProgramAudioMeterLevels] = useState<ProgramAudioMeterLevels>({
    song: createEmptyMeterChannel(),
    instants: createEmptyMeterChannel(),
    sceneInstant: createEmptyMeterChannel(),
    main: createEmptyMeterChannel(),
    updatedAt: new Date(0).toISOString()
  });
  const [programSongPlaybackState, setProgramSongPlaybackState] = useState<ProgramSongPlaybackState>({
    token: '',
    audioUrl: '',
    progress: 0,
    currentTimeMs: 0,
    durationMs: null,
    isPlaying: false,
    updatedAt: new Date(0).toISOString()
  });
  const [sceneInstantPlayback, setSceneInstantPlayback] = useState<SceneInstantPlaybackState>({
    sceneId: null,
    instantId: null,
    instantName: '',
    isPlaying: false,
    updatedAt: new Date(0).toISOString()
  });
  const programRealtimeSocketRef = useRef<WebSocket | null>(null);
  const [isProgramRealtimeConnected, setIsProgramRealtimeConnected] = useState(false);
  const latestControlVersionByTopicRef = useRef<Record<ProgramUpdateTopic, number>>({
    state: -1,
    audioBus: -1,
    audioMeter: -1,
    songPlayback: -1,
    sceneInstant: -1
  });

  const applySceneUpdateLocally = useCallback((nextScene: Scene) => {
    if (!nextScene || typeof nextScene !== 'object' || typeof nextScene.id !== 'number') {
      return;
    }

    sceneMetadataCacheRef.current[nextScene.id] = parseSceneMetadata(nextScene.metadata);

    setScenes((previous) => {
      const existingIndex = previous.findIndex((scene) => scene.id === nextScene.id);
      if (existingIndex === -1) {
        return [...previous, nextScene];
      }

      const next = [...previous];
      next[existingIndex] = nextScene;
      return next;
    });

    setProgramState((previous) => {
      if (!previous) {
        return previous;
      }

      let didUpdateSceneEntry = false;
      const nextEntries = previous.scenes.map((entry) => {
        if (entry.sceneId !== nextScene.id) {
          return entry;
        }
        didUpdateSceneEntry = true;
        return {
          ...entry,
          scene: nextScene
        };
      });

      const nextActiveScene = previous.activeScene?.id === nextScene.id ? nextScene : previous.activeScene;
      const nextStagedScene = previous.stagedScene?.id === nextScene.id ? nextScene : previous.stagedScene;
      const didUpdateHeader = nextActiveScene !== previous.activeScene || nextStagedScene !== previous.stagedScene;

      if (!didUpdateSceneEntry && !didUpdateHeader) {
        return previous;
      }

      return {
        ...previous,
        scenes: didUpdateSceneEntry ? nextEntries : previous.scenes,
        activeScene: nextActiveScene,
        stagedScene: nextStagedScene
      };
    });
  }, []);

  const shouldApplyControlUpdatePayload = useCallback((payload: unknown, topicOverride?: ProgramUpdateTopic): boolean => {
    const topic =
      topicOverride ??
      (payload && typeof payload === 'object' && !Array.isArray(payload) ? resolveControlUpdateTopicFromType((payload as Record<string, unknown>).type) : null);
    if (!topic) {
      return true;
    }

    const nextVersion = readControlUpdateVersion(topic, payload);
    if (nextVersion === null) {
      return true;
    }

    const previousVersion = latestControlVersionByTopicRef.current[topic] ?? -1;
    if (nextVersion <= previousVersion) {
      return false;
    }

    latestControlVersionByTopicRef.current[topic] = nextVersion;
    return true;
  }, []);

  useEffect(() => {
    fetchScenes();
    fetchLayouts();
    fetchComponentTypes();
    fetchSongCatalog();
  }, []);

  useEffect(() => {
    latestControlVersionByTopicRef.current = {
      state: -1,
      audioBus: -1,
      audioMeter: -1,
      songPlayback: -1,
      sceneInstant: -1
    };
    void fetchInstants();
    Object.values(instantPlaybackTimeoutsRef.current).forEach((timeoutId) => {
      window.clearTimeout(timeoutId);
    });
    instantPlaybackTimeoutsRef.current = {};
    setInstantPlayback({});
    setProgramAudioMeterLevels({
      song: createEmptyMeterChannel(),
      instants: createEmptyMeterChannel(),
      sceneInstant: createEmptyMeterChannel(),
      main: createEmptyMeterChannel(),
      updatedAt: new Date(0).toISOString()
    });
    setProgramSongPlaybackState({
      token: '',
      audioUrl: '',
      progress: 0,
      currentTimeMs: 0,
      durationMs: null,
      isPlaying: false,
      updatedAt: new Date(0).toISOString()
    });
    setSceneInstantPlayback({
      sceneId: null,
      instantId: null,
      instantName: '',
      isPlaying: false,
      updatedAt: new Date(0).toISOString()
    });
    void fetchMediaGroups(activeProgramId);
  }, [activeProgramId]);

  useEffect(() => {
    if (isProgramRealtimeConnected) {
      return;
    }

    let cancelled = false;
    const fallbackTimer = window.setTimeout(() => {
      if (cancelled || programRealtimeSocketRef.current?.readyState === WebSocket.OPEN) {
        return;
      }
      void fetchProgramState(activeProgramId);
      void fetchProgramAudioBusSettings(activeProgramId);
      void fetchProgramAudioMeter(activeProgramId);
      void fetchProgramSongPlayback(activeProgramId);
      void fetchSceneInstantPlayback(activeProgramId);
    }, 900);

    return () => {
      cancelled = true;
      window.clearTimeout(fallbackTimer);
    };
  }, [activeProgramId, isProgramRealtimeConnected]);

  useEffect(() => {
    const resyncInterval = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }

      void fetchProgramState(activeProgramId);
      void fetchSceneInstantPlayback(activeProgramId);
    }, 5000);

    return () => {
      window.clearInterval(resyncInterval);
    };
  }, [activeProgramId]);

  useEffect(() => {
    mixerLevelsRef.current = mixerLevels;
  }, [mixerLevels]);

  useEffect(() => {
    selectedSceneRef.current = selectedScene;
  }, [selectedScene]);

  useEffect(() => {
    sceneEditorPropsRef.current = sceneEditorProps;
  }, [sceneEditorProps]);

  const syncProgramStateAndStagedScene = useCallback((nextProgramState: ProgramState | null) => {
    setProgramState(nextProgramState);
    setSelectedScene((previousStagedSceneId) => {
      if (!nextProgramState) {
        return null;
      }

      const nextStagedSceneId =
        typeof nextProgramState.stagedSceneId === 'number' && nextProgramState.scenes.some((entry) => entry.sceneId === nextProgramState.stagedSceneId)
          ? nextProgramState.stagedSceneId
          : null;

      if (nextStagedSceneId !== null) {
        return nextStagedSceneId;
      }

      if (previousStagedSceneId !== null && nextProgramState.scenes.some((entry) => entry.sceneId === previousStagedSceneId)) {
        return previousStagedSceneId;
      }

      return nextProgramState.activeSceneId ?? null;
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    let disposed = false;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (disposed) {
        return;
      }

      let socket: WebSocket;
      try {
        socket = new WebSocket(getProgramRealtimeSocketUrl(activeProgramId, 'control'));
      } catch {
        reconnectTimer = window.setTimeout(connect, 1500);
        return;
      }

      programRealtimeSocketRef.current = socket;
      setIsProgramRealtimeConnected(false);

      socket.addEventListener('open', () => {
        if (disposed || programRealtimeSocketRef.current !== socket) {
          try {
            socket.close();
          } catch {
            // no-op
          }
          return;
        }
        setIsProgramRealtimeConnected(true);
      });

      socket.addEventListener('message', (event) => {
        let payload: any;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }

        if (!payload || typeof payload !== 'object') {
          return;
        }

        if (!shouldApplyControlUpdatePayload(payload)) {
          return;
        }

        if (payload.type === 'program_state_snapshot') {
          const eventProgramId = typeof payload.programId === 'string' ? payload.programId : '';
          if (eventProgramId !== activeProgramId) {
            return;
          }
          const normalizedProgramState = normalizeProgramState(payload.state);
          syncProgramStateAndStagedScene(normalizedProgramState);
          return;
        }

        if (payload.type === 'audio_bus_snapshot') {
          const eventProgramId = typeof payload.programId === 'string' ? payload.programId : '';
          if (eventProgramId !== activeProgramId) {
            return;
          }
          const nextMixerSource =
            payload.settings && typeof payload.settings === 'object' ? (payload.settings as { mixerSettings?: unknown }).mixerSettings : undefined;
          if (nextMixerSource !== undefined) {
            const nextMixerLevels = normalizeBroadcastSettingsPayload(nextMixerSource);
            mixerLevelsRef.current = nextMixerLevels;
            setMixerLevels(nextMixerLevels);
          }
          const normalizedSongSequence = normalizeProgramSongPlaylist(
            normalizeProgramSongSequence(payload?.settings?.songSequence) ?? { ...createProgramSongSequence('manual'), activeItemId: null }
          );
          setProgramAudioBusSettings({ songSequence: normalizedSongSequence });
          return;
        }

        if (payload.type === 'scene_staged') {
          const eventProgramId = typeof payload.programId === 'string' ? payload.programId : '';
          if (eventProgramId !== activeProgramId) {
            return;
          }
          const nextStagedSceneId = typeof payload.stagedSceneId === 'number' ? payload.stagedSceneId : null;
          setSelectedScene(nextStagedSceneId);
          setProgramState((previous) => {
            if (!previous) {
              return previous;
            }
            return {
              ...previous,
              stagedSceneId: nextStagedSceneId,
              stagedScene: payload.scene && typeof payload.scene === 'object' ? (payload.scene as Scene) : null
            };
          });
          return;
        }

        if (payload.type === 'scene_change' || payload.type === 'program_scenes_changed' || payload.type === 'program_media_groups_changed') {
          const eventProgramId = typeof payload.programId === 'string' ? payload.programId : '';
          if (eventProgramId !== activeProgramId) {
            return;
          }
          const normalizedProgramState = normalizeProgramState(payload.state);
          syncProgramStateAndStagedScene(normalizedProgramState);
          if (payload.type === 'program_media_groups_changed') {
            void fetchMediaGroups(activeProgramId);
          }
          return;
        }

        if (payload.type === 'scene_update') {
          const eventProgramId = typeof payload.programId === 'string' ? payload.programId : '';
          if (eventProgramId !== activeProgramId) {
            return;
          }
          if (payload.scene && typeof payload.scene === 'object') {
            applySceneUpdateLocally(payload.scene as Scene);
          }
          return;
        }

        if (payload.type === 'scene_cleared') {
          const eventProgramId = typeof payload.programId === 'string' ? payload.programId : '';
          if (eventProgramId !== activeProgramId) {
            return;
          }
          setProgramState((prev) => {
            if (!prev) {
              return prev;
            }
            return {
              ...prev,
              activeSceneId: null
            };
          });
          return;
        }

        if (payload.type === 'audio_bus_update') {
          const eventProgramId = typeof payload.programId === 'string' ? payload.programId : '';
          if (eventProgramId !== activeProgramId) {
            return;
          }
          const nextMixerSource =
            payload.settings && typeof payload.settings === 'object' ? (payload.settings as { mixerSettings?: unknown }).mixerSettings : undefined;
          if (nextMixerSource !== undefined) {
            const nextMixerLevels = normalizeBroadcastSettingsPayload(nextMixerSource);
            mixerLevelsRef.current = nextMixerLevels;
            setMixerLevels(nextMixerLevels);
          }
          const normalizedSongSequence = normalizeProgramSongPlaylist(
            normalizeProgramSongSequence(payload?.settings?.songSequence) ?? { ...createProgramSongSequence('manual'), activeItemId: null }
          );
          setProgramAudioBusSettings({ songSequence: normalizedSongSequence });
          return;
        }

        if (payload.type === 'audio_meter_update') {
          const eventProgramId = typeof payload.programId === 'string' ? payload.programId : '';
          if (eventProgramId !== activeProgramId) {
            return;
          }
          setProgramAudioMeterLevels((previous) => reconcileProgramAudioMeter(previous, normalizeProgramAudioMeter(payload.levels)));
          return;
        }

        if (payload.type === 'song_playback_update') {
          const eventProgramId = typeof payload.programId === 'string' ? payload.programId : '';
          if (eventProgramId !== activeProgramId) {
            return;
          }
          setProgramSongPlaybackState((previous) => reconcileProgramSongPlayback(previous, normalizeProgramSongPlayback(payload.playback)));
          return;
        }

        if (payload.type === 'scene_instant_state') {
          const eventProgramId = typeof payload.programId === 'string' ? payload.programId : '';
          if (eventProgramId !== activeProgramId) {
            return;
          }
          setSceneInstantPlayback(normalizeSceneInstantPlayback(payload.playback));
          return;
        }

        if (payload.type === 'scene_instant_take') {
          const eventProgramId = typeof payload.programId === 'string' ? payload.programId : '';
          if (eventProgramId !== activeProgramId) {
            return;
          }
          setSceneInstantPlayback({
            sceneId: normalizeSceneInstantId(payload.sceneId),
            instantId: normalizeSceneInstantId(payload.instant?.id),
            instantName: typeof payload.instant?.name === 'string' ? payload.instant.name : '',
            isPlaying: true,
            updatedAt: typeof payload.triggeredAt === 'string' ? payload.triggeredAt : new Date().toISOString()
          });
          return;
        }

        if (payload.type === 'scene_instant_stop') {
          const eventProgramId = typeof payload.programId === 'string' ? payload.programId : '';
          if (eventProgramId !== activeProgramId) {
            return;
          }
          setSceneInstantPlayback((previous) => ({
            ...previous,
            isPlaying: false,
            updatedAt: typeof payload.triggeredAt === 'string' ? payload.triggeredAt : new Date().toISOString()
          }));
        }
      });

      socket.addEventListener('close', () => {
        if (programRealtimeSocketRef.current === socket) {
          programRealtimeSocketRef.current = null;
        }
        setIsProgramRealtimeConnected(false);
        if (!disposed) {
          reconnectTimer = window.setTimeout(connect, 1500);
        }
      });

      socket.addEventListener('error', () => {
        try {
          socket.close();
        } catch {
          // no-op
        }
      });
    };

    connect();

    return () => {
      disposed = true;
      setIsProgramRealtimeConnected(false);

      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }

      const socket = programRealtimeSocketRef.current;
      programRealtimeSocketRef.current = null;
      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.close();
        } catch {
          // no-op
        }
      }
    };
  }, [activeProgramId, applySceneUpdateLocally, shouldApplyControlUpdatePayload, syncProgramStateAndStagedScene]);

  const fetchScenes = async () => {
    try {
      const res = await fetch(apiUrl('/scenes'));
      const data = await res.json();
      setScenes(data);
    } catch (err) {
      console.error('Failed to fetch scenes:', err);
    }
  };

  const fetchLayouts = async () => {
    try {
      const res = await fetch(apiUrl('/layouts'));
      const data = await res.json();
      setLayouts(data);
    } catch (err) {
      console.error('Failed to fetch layouts:', err);
    }
  };

  const fetchComponentTypes = async () => {
    // No-op, using constants
  };

  const fetchInstants = async () => {
    try {
      setIsLoadingInstants(true);
      const res = await fetch(apiUrl('/instants'));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as InstantItem[];
      setInstants(data);
    } catch (err) {
      console.error('Failed to fetch instants:', err);
      setInstants([]);
    } finally {
      setIsLoadingInstants(false);
    }
  };

  const fetchSongCatalog = async () => {
    try {
      const res = await fetch(apiUrl('/songs'));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as SongCatalogItem[];
      setSongCatalog(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to fetch songs catalog:', err);
      setSongCatalog([]);
    }
  };

  const fetchMediaGroups = async (targetProgramId: string = activeProgramId) => {
    try {
      setIsLoadingMediaGroups(true);
      const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/media-groups`));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as MediaGroup[];
      setMediaGroups(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to fetch media groups:', err);
      setMediaGroups([]);
    } finally {
      setIsLoadingMediaGroups(false);
    }
  };

  const persistMixerLevels = async (nextMixerLevels: BroadcastSettings) => {
    setIsSavingMixerLevels(true);
    try {
      const res = await fetch(apiUrl(`/program/${encodeURIComponent(activeProgramId)}/audio-bus`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mixerSettings: {
            mainMasterVolume: nextMixerLevels.mainMasterVolume,
            mixerChannels: nextMixerLevels.mixerChannels
          }
        })
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const payload = (await res.json()) as ProgramAudioBusSettings | null;
      if (!shouldApplyControlUpdatePayload(payload, 'audioBus')) {
        return;
      }
      const persistedMixerLevels = normalizeBroadcastSettingsPayload(payload?.mixerSettings ?? nextMixerLevels);
      mixerLevelsRef.current = persistedMixerLevels;
      setMixerLevels(persistedMixerLevels);
    } catch (err) {
      console.error('Failed to save mixer levels:', err);
    } finally {
      setIsSavingMixerLevels(false);
    }
  };

  const queueMixerSave = (nextMixerLevels: BroadcastSettings) => {
    if (mixerSaveTimeoutRef.current !== null) {
      window.clearTimeout(mixerSaveTimeoutRef.current);
    }

    mixerSaveTimeoutRef.current = window.setTimeout(() => {
      mixerSaveTimeoutRef.current = null;
      void persistMixerLevels(nextMixerLevels);
    }, 180);
  };

  const commitMixerLevels = (nextMixerLevels: BroadcastSettings) => {
    const normalizedMixerLevels = withNormalizedMixerChannels(nextMixerLevels);
    mixerLevelsRef.current = normalizedMixerLevels;
    setMixerLevels(normalizedMixerLevels);
    queueMixerSave(normalizedMixerLevels);
  };

  const setSongMasterVolume = (nextValue: number) => {
    const currentMixerLevels = mixerLevelsRef.current;
    const nextMixerLevels = {
      ...currentMixerLevels,
      songMasterVolume: normalizeMasterVolume(nextValue, currentMixerLevels.songMasterVolume)
    };
    commitMixerLevels(nextMixerLevels);
  };

  const setMainMasterVolume = (nextValue: number) => {
    const currentMixerLevels = mixerLevelsRef.current;
    const nextMixerLevels = {
      ...currentMixerLevels,
      mainMasterVolume: normalizeMasterVolume(nextValue, currentMixerLevels.mainMasterVolume)
    };
    commitMixerLevels(nextMixerLevels);
  };

  const setInstantMasterVolume = (nextValue: number) => {
    const currentMixerLevels = mixerLevelsRef.current;
    const nextMixerLevels = {
      ...currentMixerLevels,
      instantMasterVolume: normalizeMasterVolume(nextValue, currentMixerLevels.instantMasterVolume)
    };
    commitMixerLevels(nextMixerLevels);
  };

  const setSceneInstantMasterVolume = (nextValue: number) => {
    const currentMixerLevels = mixerLevelsRef.current;
    const nextMixerLevels = {
      ...currentMixerLevels,
      sceneInstantMasterVolume: normalizeMasterVolume(nextValue, currentMixerLevels.sceneInstantMasterVolume)
    };
    commitMixerLevels(nextMixerLevels);
  };

  const setStreamMasterVolume = (nextValue: number) => {
    const currentMixerLevels = mixerLevelsRef.current;
    const nextMixerLevels = {
      ...currentMixerLevels,
      streamMasterVolume: normalizeMasterVolume(nextValue, currentMixerLevels.streamMasterVolume)
    };
    commitMixerLevels(nextMixerLevels);
  };

  const getChannelMasterVolume = (mixerState: BroadcastSettings, channelId: MixerTakeChannelKey): number => {
    switch (channelId) {
      case 'song':
        return mixerState.songMasterVolume;
      case 'stream':
        return mixerState.streamMasterVolume;
      case 'instants':
        return mixerState.instantMasterVolume;
      case 'sceneInstant':
        return mixerState.sceneInstantMasterVolume;
      case 'main':
      default:
        return mixerState.mainMasterVolume;
    }
  };

  const setChannelMasterVolume = (channelId: MixerTakeChannelKey, nextValue: number) => {
    switch (channelId) {
      case 'song':
        setSongMasterVolume(nextValue);
        return;
      case 'stream':
        setStreamMasterVolume(nextValue);
        return;
      case 'instants':
        setInstantMasterVolume(nextValue);
        return;
      case 'sceneInstant':
        setSceneInstantMasterVolume(nextValue);
        return;
      case 'main':
      default:
        setMainMasterVolume(nextValue);
    }
  };

  const updateChannelTakePresetDb = (channelId: MixerTakeChannelKey, presetSide: MixerTakePresetSide, rawValue: number) => {
    setMixerTakePresetsDb((prev) => {
      const next = { ...prev };
      const key = presetSide === 'a' ? 'aDb' : 'bDb';
      const fallback = next[channelId][key];
      next[channelId] = {
        ...next[channelId],
        [key]: normalizeTakeVolumePresetDb(rawValue, fallback)
      };
      return next;
    });
  };

  const formatTakePresetDbInputValue = (value: number): string => {
    if (!Number.isFinite(value)) {
      return '-15.0';
    }
    return value.toFixed(1);
  };

  const commitTakePresetDbInput = (channelId: MixerTakeChannelKey, presetSide: MixerTakePresetSide, rawValue: string, fallbackValue: number): number => {
    const parsed = Number.parseFloat(rawValue.trim());
    const nextValue = Number.isFinite(parsed) ? normalizeTakeVolumePresetDb(parsed, fallbackValue) : fallbackValue;
    updateChannelTakePresetDb(channelId, presetSide, nextValue);
    return nextValue;
  };

  const clearTakeVolumeFadeTimer = (channelId?: MixerTakeChannelKey) => {
    if (channelId) {
      const timerId = takeVolumeFadeTimerRef.current[channelId];
      if (timerId !== null) {
        window.clearInterval(timerId);
        takeVolumeFadeTimerRef.current[channelId] = null;
      }
      return;
    }

    for (const channel of MIXER_TAKE_CHANNELS) {
      const timerId = takeVolumeFadeTimerRef.current[channel];
      if (timerId !== null) {
        window.clearInterval(timerId);
        takeVolumeFadeTimerRef.current[channel] = null;
      }
    }
  };

  const applyTakePresetToChannel = (channelId: MixerTakeChannelKey, presetSide: MixerTakePresetSide, fadeMs: number = takePresetFadeMs) => {
    const preset = mixerTakePresetsDb[channelId];
    const presetDb = presetSide === 'a' ? preset.aDb : preset.bDb;
    const normalizedPresetDb = normalizeTakeVolumePresetDb(presetDb, -15);
    const normalizedFadeMs = normalizeTakeVolumeFadeMs(fadeMs, 0);
    const currentFader = getChannelMasterVolume(mixerLevelsRef.current, channelId);
    const targetFader = normalizeMasterVolume(dbToFader(normalizedPresetDb), currentFader);

    clearTakeVolumeFadeTimer(channelId);
    takeVolumeFadeRunIdRef.current[channelId] += 1;
    const runId = takeVolumeFadeRunIdRef.current[channelId];

    if (Math.abs(targetFader - currentFader) <= 0.0001 || normalizedFadeMs <= 0) {
      setChannelMasterVolume(channelId, targetFader);
      setIsApplyingTakePresetByChannel((prev) => ({ ...prev, [channelId]: false }));
      return;
    }

    setIsApplyingTakePresetByChannel((prev) => ({ ...prev, [channelId]: true }));
    const stepIntervalMs = TAKE_VOLUME_PRESET_FADE_STEP_MIN_MS;
    const stepCount = Math.max(1, Math.ceil(normalizedFadeMs / stepIntervalMs));
    let step = 0;

    const advanceStep = () => {
      if (runId !== takeVolumeFadeRunIdRef.current[channelId]) {
        return;
      }

      step += 1;
      const ratio = Math.min(1, step / stepCount);
      const easedRatio = ratio < 0.5 ? 2 * ratio * ratio : 1 - Math.pow(-2 * ratio + 2, 2) / 2;
      const nextFader = currentFader + (targetFader - currentFader) * easedRatio;
      setChannelMasterVolume(channelId, Number(nextFader.toFixed(4)));

      if (ratio >= 1) {
        clearTakeVolumeFadeTimer(channelId);
        if (runId === takeVolumeFadeRunIdRef.current[channelId]) {
          setIsApplyingTakePresetByChannel((prev) => ({ ...prev, [channelId]: false }));
        }
      }
    };

    advanceStep();
    if (step >= stepCount) {
      return;
    }

    takeVolumeFadeTimerRef.current[channelId] = window.setInterval(advanceStep, stepIntervalMs);
  };

  const triggerChannelTake = (channelId: MixerTakeChannelKey) => {
    const targetPresetSide = mixerTakeTargetSide[channelId];
    applyTakePresetToChannel(channelId, targetPresetSide, takePresetFadeMs);
    setMixerTakeTargetSide((prev) => ({
      ...prev,
      [channelId]: targetPresetSide === 'a' ? 'b' : 'a'
    }));
  };

  const toggleSongMuted = () => {
    const currentMixerLevels = mixerLevelsRef.current;
    commitMixerLevels({
      ...currentMixerLevels,
      songMuted: !currentMixerLevels.songMuted
    });
  };

  const toggleInstantMuted = () => {
    const currentMixerLevels = mixerLevelsRef.current;
    commitMixerLevels({
      ...currentMixerLevels,
      instantMuted: !currentMixerLevels.instantMuted
    });
  };

  const toggleStreamMuted = () => {
    const currentMixerLevels = mixerLevelsRef.current;
    commitMixerLevels({
      ...currentMixerLevels,
      streamMuted: !currentMixerLevels.streamMuted
    });
  };

  const toggleSceneInstantMuted = () => {
    const currentMixerLevels = mixerLevelsRef.current;
    commitMixerLevels({
      ...currentMixerLevels,
      sceneInstantMuted: !currentMixerLevels.sceneInstantMuted
    });
  };

  const toggleSongSolo = () => {
    const currentMixerLevels = mixerLevelsRef.current;
    commitMixerLevels({
      ...currentMixerLevels,
      songSolo: !currentMixerLevels.songSolo
    });
  };

  const toggleInstantSolo = () => {
    const currentMixerLevels = mixerLevelsRef.current;
    commitMixerLevels({
      ...currentMixerLevels,
      instantSolo: !currentMixerLevels.instantSolo
    });
  };

  const toggleStreamSolo = () => {
    const currentMixerLevels = mixerLevelsRef.current;
    commitMixerLevels({
      ...currentMixerLevels,
      streamSolo: !currentMixerLevels.streamSolo
    });
  };

  const toggleSceneInstantSolo = () => {
    const currentMixerLevels = mixerLevelsRef.current;
    commitMixerLevels({
      ...currentMixerLevels,
      sceneInstantSolo: !currentMixerLevels.sceneInstantSolo
    });
  };

  const fetchProgramAudioMeter = async (targetProgramId: string) => {
    try {
      const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/audio-meter`));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const payload = await res.json();
      if (!shouldApplyControlUpdatePayload(payload, 'audioMeter')) {
        return;
      }
      setProgramAudioMeterLevels(normalizeProgramAudioMeter(payload));
    } catch (err) {
      console.error('Failed to fetch program audio meter levels:', err);
      setProgramAudioMeterLevels({
        song: createEmptyMeterChannel(),
        instants: createEmptyMeterChannel(),
        sceneInstant: createEmptyMeterChannel(),
        main: createEmptyMeterChannel(),
        updatedAt: new Date(0).toISOString()
      });
    }
  };

  const fetchProgramSongPlayback = async (targetProgramId: string) => {
    try {
      const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/song-playback`));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const payload = await res.json();
      if (!shouldApplyControlUpdatePayload(payload, 'songPlayback')) {
        return;
      }
      setProgramSongPlaybackState(normalizeProgramSongPlayback(payload));
    } catch (err) {
      console.error('Failed to fetch program song playback:', err);
      setProgramSongPlaybackState({
        token: '',
        audioUrl: '',
        progress: 0,
        currentTimeMs: 0,
        durationMs: null,
        isPlaying: false,
        updatedAt: new Date(0).toISOString()
      });
    }
  };

  const fetchSceneInstantPlayback = async (targetProgramId: string) => {
    try {
      const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/scene-instant`));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const payload = await res.json();
      if (!shouldApplyControlUpdatePayload(payload, 'sceneInstant')) {
        return;
      }
      setSceneInstantPlayback(normalizeSceneInstantPlayback(payload));
    } catch (err) {
      console.error('Failed to fetch scene instant playback:', err);
      setSceneInstantPlayback({
        sceneId: null,
        instantId: null,
        instantName: '',
        isPlaying: false,
        updatedAt: new Date(0).toISOString()
      });
    }
  };

  const fetchProgramState = async (targetProgramId: string) => {
    try {
      const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/state`));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = (await res.json()) as unknown;
      if (!shouldApplyControlUpdatePayload(data, 'state')) {
        return;
      }
      const normalizedProgramState = normalizeProgramState(data);

      syncProgramStateAndStagedScene(normalizedProgramState);
    } catch (err) {
      console.error('Failed to fetch program state:', err);
    }
  };

  const fetchProgramAudioBusSettings = async (targetProgramId: string) => {
    try {
      setIsLoadingMixerLevels(true);
      const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/audio-bus`));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const payload = (await res.json()) as Partial<ProgramAudioBusSettings> | null;
      if (!shouldApplyControlUpdatePayload(payload, 'audioBus')) {
        return;
      }
      const nextMixerLevels = normalizeBroadcastSettingsPayload(payload?.mixerSettings);
      mixerLevelsRef.current = nextMixerLevels;
      setMixerLevels(nextMixerLevels);
      const normalizedSongSequence = normalizeProgramSongPlaylist(
        normalizeProgramSongSequence(payload?.songSequence) ?? { ...createProgramSongSequence('manual'), activeItemId: null }
      );
      setProgramAudioBusSettings({ songSequence: normalizedSongSequence });
    } catch (err) {
      console.error('Failed to fetch program audio bus settings:', err);
      const fallbackMixerLevels = normalizeBroadcastSettingsPayload(null);
      mixerLevelsRef.current = fallbackMixerLevels;
      setMixerLevels(fallbackMixerLevels);
      setProgramAudioBusSettings({
        songSequence: { ...createProgramSongSequence('manual'), activeItemId: null }
      });
    } finally {
      setIsLoadingMixerLevels(false);
    }
  };

  const saveProgramAudioBusSongSequence = async (nextSequence: ProgramSongSequence) => {
    const normalizedSongSequence = normalizeProgramSongPlaylist(
      normalizeProgramSongSequence(nextSequence) ?? { ...createProgramSongSequence('manual'), activeItemId: null }
    );
    setProgramAudioBusSettings({ songSequence: normalizedSongSequence });
    setIsSavingProgramAudioBus(true);

    try {
      const res = await fetch(apiUrl(`/program/${encodeURIComponent(activeProgramId)}/audio-bus`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          songSequence: normalizedSongSequence
        })
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const payload = (await res.json()) as Partial<ProgramAudioBusSettings> | null;
      if (!shouldApplyControlUpdatePayload(payload, 'audioBus')) {
        return;
      }
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'mixerSettings')) {
        const nextMixerLevels = normalizeBroadcastSettingsPayload(payload.mixerSettings);
        mixerLevelsRef.current = nextMixerLevels;
        setMixerLevels(nextMixerLevels);
      }
      const persistedSongSequence = normalizeProgramSongPlaylist(normalizeProgramSongSequence(payload?.songSequence) ?? normalizedSongSequence);
      setProgramAudioBusSettings({ songSequence: persistedSongSequence });
    } catch (err) {
      console.error('Failed to save program audio bus settings:', err);
    } finally {
      setIsSavingProgramAudioBus(false);
    }
  };

  const takeProgramSongOffAir = async (targetProgramId: string = activeProgramId) => {
    try {
      const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/song/off-air`), {
        method: 'POST'
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      console.error('Failed to take song off air:', err);
    }
  };

  const buildComponentPropsForScene = (scene: Scene): Record<string, any> => {
    const metadata = parseSceneMetadata(scene.metadata);
    const legacyFifthBell = metadata?.fifthbell && typeof metadata.fifthbell === 'object' && !Array.isArray(metadata.fifthbell) ? metadata.fifthbell : {};

    const components = scene.layout.componentType.split(',').filter(Boolean);
    const combined: Record<string, any> = {};

    for (const componentType of components) {
      if (componentType === 'modoitaliano-clock') {
        continue;
      }

      const compatibleMetadata =
        componentType === 'fifthbell-content' || componentType === 'fifthbell-marquee'
          ? { ...legacyFifthBell, ...(metadata[componentType] || {}) }
          : componentType === 'toni-chyron' || componentType === 'fifthbell-chyron'
            ? {
                ...(metadata['toni-chyron'] || {}),
                ...(metadata['fifthbell-chyron'] || {}),
                ...(metadata[componentType] || {})
              }
            : componentType === 'toni-clock' || componentType === 'fifthbell-clock' || componentType === 'fifthbell-corner'
              ? {
                  ...legacyFifthBell,
                  ...(metadata['fifthbell-corner'] || {}),
                  ...(metadata['fifthbell-clock'] || {}),
                  ...(metadata['toni-clock'] || {}),
                  ...(metadata[componentType] || {})
                }
              : metadata[componentType] || {};

      combined[componentType] = {
        ...getDefaultPropsForComponent(componentType),
        ...compatibleMetadata
      };
    }

    const sceneInstantConfig =
      metadata?.sceneInstant && typeof metadata.sceneInstant === 'object' && !Array.isArray(metadata.sceneInstant)
        ? (metadata.sceneInstant as Record<string, unknown>)
        : null;
    combined.sceneInstant = {
      instantId: normalizeSceneInstantId(sceneInstantConfig?.instantId) ?? null
    };

    return combined;
  };

  const assignedSceneEntries = useMemo(() => {
    if (!programState || !Array.isArray(programState.scenes)) {
      return [] as ProgramSceneEntry[];
    }
    return programState.scenes;
  }, [programState]);

  const assignedScenes = useMemo(() => {
    if (assignedSceneEntries.length === 0) {
      return [] as Scene[];
    }
    return assignedSceneEntries.map((entry) => entry.scene);
  }, [assignedSceneEntries]);

  const isSceneAssigned = (sceneId: number) => assignedSceneEntries.some((programScene) => programScene.sceneId === sceneId);

  const assignSceneToProgram = async (sceneId: number) => {
    try {
      await fetch(apiUrl(`/program/${encodeURIComponent(activeProgramId)}/scenes`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneId })
      });
      if (!isProgramRealtimeConnected) {
        await fetchProgramState(activeProgramId);
      }
    } catch (err) {
      console.error('Failed to assign scene to program:', err);
    }
  };

  const stageSceneForProgram = async (sceneId: number | null) => {
    try {
      const response = await fetch(apiUrl(`/program/${encodeURIComponent(activeProgramId)}/stage`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneId })
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      if (!isProgramRealtimeConnected) {
        await fetchProgramState(activeProgramId);
      }
    } catch (err) {
      console.error('Failed to stage scene for program:', err);
    }
  };

  const activateScene = async (sceneId: number) => {
    try {
      if (!isSceneAssigned(sceneId)) {
        await assignSceneToProgram(sceneId);
      }
      await fetch(apiUrl(`/program/${encodeURIComponent(activeProgramId)}/activate`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneId, transitionId: selectedTransitionId })
      });
      setSelectedScene(sceneId);
      if (!isProgramRealtimeConnected) {
        await fetchProgramState(activeProgramId);
      }
    } catch (err) {
      console.error('Failed to activate scene:', err);
    }
  };

  const takeStagedSceneLive = async () => {
    if (!selectedScene) {
      return;
    }

    try {
      await flushSceneAttributeAutosaveForScene(selectedScene);
      await activateScene(selectedScene);
    } catch (err) {
      console.error('Could not save staged scene attributes before taking live:', err);
    }
  };

  const saveStagedSceneAttributes = async () => {
    const sceneId = selectedSceneRef.current;
    if (sceneId === null) {
      return;
    }

    if (sceneEditorAutosaveTimerRef.current !== null) {
      window.clearTimeout(sceneEditorAutosaveTimerRef.current);
      sceneEditorAutosaveTimerRef.current = null;
    }

    const nextSceneProps = sceneEditorPropsRef.current;
    const nextSignature = JSON.stringify(nextSceneProps);

    setIsSavingSceneAttributes(true);
    setSceneAttributeSaveError(null);
    try {
      await persistSceneAttributes(sceneId, nextSceneProps);
      sceneEditorAutosaveSignatureRef.current = nextSignature;
      sceneEditorDirtyRef.current = false;
      if (pendingSceneAttributeSaveRef.current?.sceneId === sceneId) {
        pendingSceneAttributeSaveRef.current = null;
      }
    } catch (err) {
      setSceneAttributeSaveError('Scene save failed. Please try again.');
      console.error('Failed to save staged scene attributes:', err);
    } finally {
      setIsSavingSceneAttributes(false);
    }
  };

  const takeSceneInstant = async (sceneId: number | null = selectedScene, instantIdOverride?: number | null) => {
    const normalizedSceneId = typeof sceneId === 'number' && Number.isFinite(sceneId) ? sceneId : null;
    const normalizedInstantId = normalizeSceneInstantId(instantIdOverride);
    if (normalizedSceneId === null) {
      return;
    }

    try {
      await flushSceneAttributeAutosaveForScene(normalizedSceneId);
      const res = await fetch(apiUrl(`/program/${encodeURIComponent(activeProgramId)}/scene-instant/take`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sceneId: normalizedSceneId,
          instantId: normalizedInstantId
        })
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const payload = await res.json();
      setSceneInstantPlayback(normalizeSceneInstantPlayback(payload));
    } catch (err) {
      console.error('Failed to take scene instant:', err);
    }
  };

  const stopSceneInstant = async () => {
    try {
      const res = await fetch(apiUrl(`/program/${encodeURIComponent(activeProgramId)}/scene-instant/stop`), {
        method: 'POST'
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const payload = await res.json();
      setSceneInstantPlayback(normalizeSceneInstantPlayback(payload));
    } catch (err) {
      console.error('Failed to stop scene instant:', err);
    }
  };

  const triggerInstant = async (instantId: number) => {
    try {
      const res = await fetch(apiUrl(`/instants/${instantId}/play?programId=${encodeURIComponent(activeProgramId)}`), {
        method: 'POST'
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const startedAtMs = Date.now();
      const durationMs = instantDurationsMs[instantId];
      const existingTimeoutId = instantPlaybackTimeoutsRef.current[instantId];
      if (existingTimeoutId !== undefined) {
        window.clearTimeout(existingTimeoutId);
        delete instantPlaybackTimeoutsRef.current[instantId];
      }
      setInstantPlayback((prev) => ({
        ...prev,
        [instantId]: {
          startedAtMs,
          endsAtMs: typeof durationMs === 'number' && durationMs > 0 ? startedAtMs + durationMs : null
        }
      }));

      if (typeof durationMs === 'number' && durationMs > 0) {
        const timeoutId = window.setTimeout(() => {
          delete instantPlaybackTimeoutsRef.current[instantId];
          setInstantPlayback((prev) => {
            if (!prev[instantId]) {
              return prev;
            }
            const next = { ...prev };
            delete next[instantId];
            return next;
          });
        }, durationMs);
        instantPlaybackTimeoutsRef.current[instantId] = timeoutId;
      }
    } catch (err) {
      console.error('Failed to trigger instant:', err);
    }
  };

  const stopAllInstants = async () => {
    try {
      const res = await fetch(apiUrl(`/instants/stop-all?programId=${encodeURIComponent(activeProgramId)}`), {
        method: 'POST'
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      Object.values(instantPlaybackTimeoutsRef.current).forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      instantPlaybackTimeoutsRef.current = {};
      setInstantPlayback({});
    } catch (err) {
      console.error('Failed to stop all instants:', err);
    }
  };

  useEffect(() => {
    const instantIds = new Set(instants.map((instant) => instant.id));
    setInstantDurationsMs((prev) => {
      let changed = false;
      const next: Record<number, number | null> = {};

      for (const [key, value] of Object.entries(prev)) {
        const id = Number(key);
        if (instantIds.has(id)) {
          next[id] = value;
        } else {
          changed = true;
        }
      }

      return changed ? next : prev;
    });

    setInstantPlayback((prev) => {
      let changed = false;
      const next: Record<number, InstantPlaybackState> = {};

      for (const [key, value] of Object.entries(prev)) {
        const id = Number(key);
        if (instantIds.has(id)) {
          next[id] = value;
        } else {
          changed = true;
        }
      }

      return changed ? next : prev;
    });

    const currentTimeouts = instantPlaybackTimeoutsRef.current;
    for (const key of Object.keys(currentTimeouts)) {
      const id = Number(key);
      if (!instantIds.has(id)) {
        window.clearTimeout(currentTimeouts[id]);
        delete currentTimeouts[id];
      }
    }
  }, [instants]);

  useEffect(() => {
    let cancelled = false;

    const loadDurationForInstant = (instant: InstantItem) => {
      if (!instant.audioUrl) {
        return;
      }

      const cachedDuration = instantDurationByUrlRef.current[instant.audioUrl];
      if (cachedDuration !== undefined) {
        setInstantDurationsMs((prev) => (prev[instant.id] === cachedDuration ? prev : { ...prev, [instant.id]: cachedDuration }));
        return;
      }

      const audio = new Audio();
      const cleanup = () => {
        audio.onloadedmetadata = null;
        audio.onerror = null;
        audio.src = '';
      };

      audio.preload = 'metadata';
      audio.onloadedmetadata = () => {
        const seconds = Number(audio.duration);
        const durationMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
        instantDurationByUrlRef.current[instant.audioUrl] = durationMs;

        if (!cancelled) {
          setInstantDurationsMs((prev) => ({
            ...prev,
            [instant.id]: durationMs
          }));
        }

        cleanup();
      };

      audio.onerror = () => {
        instantDurationByUrlRef.current[instant.audioUrl] = null;
        if (!cancelled) {
          setInstantDurationsMs((prev) => ({
            ...prev,
            [instant.id]: null
          }));
        }
        cleanup();
      };

      audio.src = instant.audioUrl;
      audio.load();
    };

    for (const instant of instants) {
      loadDurationForInstant(instant);
    }

    return () => {
      cancelled = true;
    };
  }, [instants]);

  useEffect(() => {
    return () => {
      Object.values(instantPlaybackTimeoutsRef.current).forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      instantPlaybackTimeoutsRef.current = {};
      clearTakeVolumeFadeTimer();
      if (mixerSaveTimeoutRef.current !== null) {
        window.clearTimeout(mixerSaveTimeoutRef.current);
        mixerSaveTimeoutRef.current = null;
      }
      if (sceneEditorAutosaveTimerRef.current !== null) {
        window.clearTimeout(sceneEditorAutosaveTimerRef.current);
        sceneEditorAutosaveTimerRef.current = null;
      }
      if (sceneAttributeRetryTimerRef.current !== null) {
        window.clearTimeout(sceneAttributeRetryTimerRef.current);
        sceneAttributeRetryTimerRef.current = null;
      }
      if (sceneAttributeFlushKickTimerRef.current !== null) {
        window.clearTimeout(sceneAttributeFlushKickTimerRef.current);
        sceneAttributeFlushKickTimerRef.current = null;
      }
      sceneAttributeRetryDelayMsRef.current = 800;
      setSceneAttributeSaveError(null);
      pendingSceneAttributeSaveRef.current = null;
      sceneAttributeSaveDrainPromiseRef.current = null;
    };
  }, []);

  const updateSceneEditorProp = (componentType: string, propName: string, value: any) => {
    const nextSceneProps = {
      ...sceneEditorPropsRef.current,
      [componentType]: {
        ...sceneEditorPropsRef.current[componentType],
        [propName]: value
      }
    };
    sceneEditorDirtyRef.current = true;
    sceneEditorPropsRef.current = nextSceneProps;
    setSceneEditorProps(nextSceneProps);
    if (selectedSceneRef.current) {
      queueSceneAttributePersist(selectedSceneRef.current, nextSceneProps);
    }
  };

  const replaceSceneEditorComponentProps = (componentType: string, nextProps: any) => {
    const nextSceneProps = {
      ...sceneEditorPropsRef.current,
      [componentType]: nextProps
    };
    sceneEditorDirtyRef.current = true;
    sceneEditorPropsRef.current = nextSceneProps;
    setSceneEditorProps(nextSceneProps);
    if (selectedSceneRef.current) {
      queueSceneAttributePersist(selectedSceneRef.current, nextSceneProps);
    }
  };

  const persistSceneAttributes = useCallback(
    async (sceneId: number, nextSceneProps: ComponentPropsMap) => {
      const existingMetadata = sceneMetadataCacheRef.current[sceneId] ?? {};
      const nextMetadata = withIndependentProgramClockMetadata({
        ...existingMetadata,
        ...nextSceneProps
      });

      const response = await fetch(apiUrl(`/scenes/${sceneId}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metadata: nextMetadata
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const persistedScene = (await response.json()) as Scene;
      applySceneUpdateLocally(persistedScene);
    },
    [applySceneUpdateLocally]
  );

  const flushQueuedSceneAttributeSaves = useCallback((): Promise<void> => {
    if (sceneAttributeSaveDrainPromiseRef.current) {
      return sceneAttributeSaveDrainPromiseRef.current;
    }

    if (!pendingSceneAttributeSaveRef.current) {
      return Promise.resolve();
    }

    const drainPromise = (async () => {
      if (sceneAttributeRetryTimerRef.current !== null) {
        window.clearTimeout(sceneAttributeRetryTimerRef.current);
        sceneAttributeRetryTimerRef.current = null;
      }

      setIsSavingSceneAttributes(true);
      let lastError: unknown = null;
      try {
        while (pendingSceneAttributeSaveRef.current) {
          const payload = pendingSceneAttributeSaveRef.current;
          pendingSceneAttributeSaveRef.current = null;

          try {
            await persistSceneAttributes(payload.sceneId, payload.props);
            sceneAttributeRetryDelayMsRef.current = 800;
            setSceneAttributeSaveError(null);
            if (selectedSceneRef.current === payload.sceneId) {
              sceneEditorAutosaveSignatureRef.current = payload.signature;
              if (payload.revision >= sceneEditorRevisionRef.current) {
                sceneEditorDirtyRef.current = false;
              }
            }
          } catch (err) {
            pendingSceneAttributeSaveRef.current = payload;
            setSceneAttributeSaveError('Scene save failed. Retrying...');
            console.error('Failed to update scene attributes:', err);
            lastError = err;
            break;
          }
        }
      } finally {
        setIsSavingSceneAttributes(false);
      }

      if (lastError) {
        if (pendingSceneAttributeSaveRef.current && sceneAttributeRetryTimerRef.current === null) {
          const retryDelayMs = sceneAttributeRetryDelayMsRef.current;
          sceneAttributeRetryTimerRef.current = window.setTimeout(() => {
            sceneAttributeRetryTimerRef.current = null;
            void flushQueuedSceneAttributeSaves().catch(() => {
              // no-op, retry timer is rescheduled in flush on failure
            });
          }, retryDelayMs);
          sceneAttributeRetryDelayMsRef.current = Math.min(8000, Math.round(retryDelayMs * 1.8));
        }
        throw lastError;
      }

      setSceneAttributeSaveError(null);
    })();

    sceneAttributeSaveDrainPromiseRef.current = drainPromise.finally(() => {
      if (sceneAttributeSaveDrainPromiseRef.current === drainPromise) {
        sceneAttributeSaveDrainPromiseRef.current = null;
      }

      // If a new payload was queued while the previous drain promise was
      // still resolving, guarantee we kick off another drain pass.
      if (pendingSceneAttributeSaveRef.current && !sceneAttributeSaveDrainPromiseRef.current && sceneAttributeRetryTimerRef.current === null) {
        void flushQueuedSceneAttributeSaves().catch(() => {
          // no-op, retry timer is scheduled by flush
        });
      }
    });

    return sceneAttributeSaveDrainPromiseRef.current;
  }, [persistSceneAttributes]);

  const queueSceneAttributePersist = useCallback(
    (sceneId: number, nextSceneProps: ComponentPropsMap) => {
      const signature = JSON.stringify(nextSceneProps);
      const payload: SceneAttributeSavePayload = {
        sceneId,
        signature,
        props: JSON.parse(signature) as ComponentPropsMap,
        revision: ++sceneEditorRevisionRef.current
      };
      pendingSceneAttributeSaveRef.current = payload;
      void flushQueuedSceneAttributeSaves().catch(() => {
        // no-op, retry timer is scheduled by flush
      });

      if (sceneAttributeFlushKickTimerRef.current === null) {
        sceneAttributeFlushKickTimerRef.current = window.setTimeout(() => {
          sceneAttributeFlushKickTimerRef.current = null;
          if (pendingSceneAttributeSaveRef.current && !sceneAttributeSaveDrainPromiseRef.current && sceneAttributeRetryTimerRef.current === null) {
            void flushQueuedSceneAttributeSaves().catch(() => {
              // no-op, retry timer is scheduled by flush
            });
          }
        }, 0);
      }
    },
    [flushQueuedSceneAttributeSaves]
  );

  const flushSceneAttributeAutosaveForScene = useCallback(
    async (sceneId: number | null) => {
      if (sceneId === null) {
        return;
      }

      if (sceneEditorAutosaveTimerRef.current !== null) {
        window.clearTimeout(sceneEditorAutosaveTimerRef.current);
        sceneEditorAutosaveTimerRef.current = null;
      }

      if (selectedSceneRef.current === sceneId) {
        const latestProps = sceneEditorPropsRef.current;
        if (sceneEditorDirtyRef.current) {
          queueSceneAttributePersist(sceneId, latestProps);
        }
      }

      await flushQueuedSceneAttributeSaves();
    },
    [flushQueuedSceneAttributeSaves, queueSceneAttributePersist]
  );

  const commitSceneEditorComponentProps = async (componentType: string, nextProps: any) => {
    const nextSceneProps = {
      ...sceneEditorPropsRef.current,
      [componentType]: nextProps
    };
    sceneEditorDirtyRef.current = true;
    sceneEditorPropsRef.current = nextSceneProps;
    setSceneEditorProps(nextSceneProps);
    if (selectedSceneRef.current) {
      queueSceneAttributePersist(selectedSceneRef.current, nextSceneProps);
      try {
        await flushQueuedSceneAttributeSaves();
      } catch (err) {
        console.error('Failed to commit scene editor component props:', err);
      }
    }
  };

  useEffect(() => {
    const previousSelectedSceneId = previousSelectedSceneRef.current;
    if (previousSelectedSceneId !== null && previousSelectedSceneId !== selectedScene) {
      const previousProps = sceneEditorPropsRef.current;
      if (sceneEditorDirtyRef.current) {
        queueSceneAttributePersist(previousSelectedSceneId, previousProps);
      }
    }
    previousSelectedSceneRef.current = selectedScene;

    if (
      previousSelectedSceneId !== null &&
      previousSelectedSceneId === selectedScene &&
      (sceneEditorDirtyRef.current || pendingSceneAttributeSaveRef.current || sceneAttributeSaveDrainPromiseRef.current)
    ) {
      return;
    }

    if (!selectedScene) {
      sceneEditorAutosaveSignatureRef.current = '';
      sceneEditorDirtyRef.current = false;
      sceneEditorRevisionRef.current = 0;
      setSceneAttributeSaveError(null);
      sceneEditorPropsRef.current = {};
      setSceneEditorProps({});
      return;
    }

    const scene = assignedScenes.find((entry) => entry.id === selectedScene) ?? scenes.find((entry) => entry.id === selectedScene);
    if (!scene) {
      sceneEditorAutosaveSignatureRef.current = '';
      sceneEditorDirtyRef.current = false;
      sceneEditorRevisionRef.current = 0;
      setSceneAttributeSaveError(null);
      sceneEditorPropsRef.current = {};
      setSceneEditorProps({});
      return;
    }

    sceneMetadataCacheRef.current[selectedScene] = parseSceneMetadata(scene.metadata);
    const nextProps = buildComponentPropsForScene(scene);
    sceneEditorAutosaveSignatureRef.current = JSON.stringify(nextProps);
    sceneEditorDirtyRef.current = false;
    sceneEditorRevisionRef.current = 0;
    setSceneAttributeSaveError(null);
    sceneEditorPropsRef.current = nextProps;
    setSceneEditorProps(nextProps);
  }, [assignedScenes, queueSceneAttributePersist, scenes, selectedScene]);

  useEffect(() => {
    if (!selectedScene) {
      return;
    }

    if (!sceneEditorDirtyRef.current) {
      return;
    }

    if (sceneEditorAutosaveTimerRef.current !== null) {
      window.clearTimeout(sceneEditorAutosaveTimerRef.current);
    }

    sceneEditorAutosaveTimerRef.current = window.setTimeout(() => {
      sceneEditorAutosaveTimerRef.current = null;
      if (!selectedSceneRef.current) {
        return;
      }
      queueSceneAttributePersist(selectedSceneRef.current, sceneEditorPropsRef.current);
    }, 350);

    return () => {
      if (sceneEditorAutosaveTimerRef.current !== null) {
        window.clearTimeout(sceneEditorAutosaveTimerRef.current);
        sceneEditorAutosaveTimerRef.current = null;
      }
    };
  }, [queueSceneAttributePersist, sceneEditorProps, selectedScene]);

  useEffect(() => {
    const flushPendingSceneSaves = () => {
      const sceneId = selectedSceneRef.current;
      if (sceneId !== null) {
        void flushSceneAttributeAutosaveForScene(sceneId).catch(() => {
          // no-op
        });
        return;
      }

      void flushQueuedSceneAttributeSaves().catch(() => {
        // no-op
      });
    };

    window.addEventListener('pagehide', flushPendingSceneSaves);
    window.addEventListener('beforeunload', flushPendingSceneSaves);
    return () => {
      window.removeEventListener('pagehide', flushPendingSceneSaves);
      window.removeEventListener('beforeunload', flushPendingSceneSaves);
    };
  }, [flushQueuedSceneAttributeSaves, flushSceneAttributeAutosaveForScene]);

  const openSceneModal = () => {
    if (layouts.length === 0) {
      alert('Please create a layout first');
      return;
    }
    setEditingScene(null);
    setNewSceneName('');
    setSelectedLayoutId(null);
    setSceneComponentProps({});
    setSceneErrors({ name: '', layout: '', props: '' });
    setShowSceneModal(true);
  };

  const openEditSceneModal = (scene: Scene) => {
    setEditingScene(scene);
    setNewSceneName(scene.name);
    setSelectedLayoutId(scene.layoutId);

    try {
      const metadata = parseSceneMetadata(scene.metadata);
      if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
        setSceneComponentProps(buildComponentPropsForScene(scene));
      } else {
        handleLayoutSelect(scene.layoutId);
      }
    } catch (err) {
      console.error('Failed to parse scene metadata:', err);
      handleLayoutSelect(scene.layoutId);
    }

    setSceneErrors({ name: '', layout: '', props: '' });
    setShowSceneModal(true);
  };

  const closeSceneModal = () => {
    setShowSceneModal(false);
    setEditingScene(null);
    setNewSceneName('');
    setSelectedLayoutId(null);
    setSceneComponentProps({});
    setSceneErrors({ name: '', layout: '', props: '' });
  };

  const handleLayoutSelect = (layoutId: number) => {
    setSelectedLayoutId(layoutId);
    const layout = layouts.find((l) => l.id === layoutId);
    if (layout) {
      const components = layout.componentType.split(',').filter(Boolean);
      const initialProps: Record<string, any> = {};
      components.forEach((comp) => {
        if (comp === 'modoitaliano-clock') {
          return;
        }
        initialProps[comp] = getDefaultPropsForComponent(comp);
      });
      setSceneComponentProps(initialProps);
    }
  };

  const getDefaultPropsForComponent = (componentType: string): any => {
    const base = getStaticDefaultProps(componentType);
    switch (componentType) {
      case 'header':
        return { ...base, date: new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }) };
      case 'reloj-digital-loop-clock':
        return { ...base, textSequence: createProgramTextSequence('manual'), ctaSequence: createProgramTextSequence('manual') };
      case 'modoitaliano-chyron':
        return { ...base, textSequence: createProgramTextSequence('manual', { includeMarquee: true }), ctaSequence: createProgramTextSequence('manual') };
      case 'fifthbell-content':
        return { ...base, weatherCities: [...FIFTHBELL_AVAILABLE_WEATHER_CITIES] };
      case 'fifthbell':
        return {
          ...getDefaultPropsForComponent('fifthbell-content'),
          ...getDefaultPropsForComponent('fifthbell-marquee'),
          ...getDefaultPropsForComponent('toni-clock')
        };
      default:
        return base;
    }
  };

  const updateComponentProp = (componentType: string, propName: string, value: any) => {
    setSceneComponentProps((prev) => ({
      ...prev,
      [componentType]: {
        ...prev[componentType],
        [propName]: value
      }
    }));
  };

  const replaceSceneComponentProps = (componentType: string, nextProps: any) => {
    setSceneComponentProps((prev) => ({
      ...prev,
      [componentType]: nextProps
    }));
  };

  const createScene = async () => {
    const errors = { name: '', layout: '', props: '' };

    if (!newSceneName.trim()) {
      errors.name = 'Please enter a scene name';
    }

    if (!selectedLayoutId) {
      errors.layout = 'Please select a layout';
    }

    if (errors.name || errors.layout) {
      setSceneErrors(errors);
      return;
    }

    setIsCreatingScene(true);

    try {
      const existingMetadata = editingScene ? parseSceneMetadata(editingScene.metadata) : {};
      const payload = {
        name: newSceneName,
        layoutId: selectedLayoutId,
        metadata: withIndependentProgramClockMetadata({
          ...existingMetadata,
          ...sceneComponentProps
        })
      };

      const url = editingScene ? apiUrl(`/scenes/${editingScene.id}`) : apiUrl('/scenes');
      const method = editingScene ? 'PUT' : 'POST';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      await fetchScenes();
      closeSceneModal();
    } catch (err) {
      console.error('Failed to save scene:', err);
      setSceneErrors({ ...errors, name: 'Failed to save scene. Please try again.' });
    } finally {
      setIsCreatingScene(false);
    }
  };

  const deleteScene = async (id: number) => {
    if (!confirm('Are you sure you want to delete this scene?')) return;

    try {
      await fetch(apiUrl(`/scenes/${id}`), {
        method: 'DELETE'
      });
      if (selectedScene === id) {
        setSelectedScene(null);
        void stageSceneForProgram(null);
      }
      fetchScenes();
      if (!isProgramRealtimeConnected) {
        fetchProgramState(activeProgramId);
      }
    } catch (err) {
      console.error('Failed to delete scene:', err);
    }
  };

  useEffect(() => {
    let sceneHotkeyArmedUntil = 0;

    const handleSceneHotkey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      if (event.ctrlKey && key === 's') {
        event.preventDefault();
        sceneHotkeyArmedUntil = Date.now() + 1500;
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }

      if (!event.ctrlKey) {
        return;
      }

      if (event.code === 'Enter') {
        event.preventDefault();
        void takeStagedSceneLive();
        return;
      }

      const match = event.code.match(/^Digit(\d)$/);
      if (match && Date.now() <= sceneHotkeyArmedUntil) {
        const pressedDigit = Number(match[1]);
        const shortcutIndex = pressedDigit === 0 ? 9 : pressedDigit - 1;
        const shortcutScene = assignedScenes[shortcutIndex];
        if (!shortcutScene) {
          return;
        }

        event.preventDefault();
        sceneHotkeyArmedUntil = 0;
        setSelectedScene(shortcutScene.id);
        void stageSceneForProgram(shortcutScene.id);
        return;
      }

      if (event.metaKey || event.altKey || event.shiftKey) {
        return;
      }

      if (!/^[a-z]$/.test(key)) {
        return;
      }

      const shortcutIndex = INSTANT_SHORTCUT_KEYS.indexOf(key);
      if (shortcutIndex === -1) {
        return;
      }
      const shortcutInstant = instants[shortcutIndex];
      if (!shortcutInstant || !shortcutInstant.enabled) {
        return;
      }

      event.preventDefault();
      void triggerInstant(shortcutInstant.id);
    };

    window.addEventListener('keydown', handleSceneHotkey);
    return () => {
      window.removeEventListener('keydown', handleSceneHotkey);
    };
  }, [assignedScenes, instants, takeStagedSceneLive, triggerInstant, stageSceneForProgram]);

  const handleProgramEvent = useCallback(
    (data: any) => {
      if (!data || typeof data !== 'object') {
        return;
      }

      if (isProgramRealtimeConnected) {
        return;
      }

      const eventProgramId = typeof data.programId === 'string' ? data.programId : '';
      if (eventProgramId && eventProgramId !== activeProgramId) {
        return;
      }

      if (!shouldApplyControlUpdatePayload(data)) {
        return;
      }

      if (data.type === 'scene_change' || data.type === 'program_scenes_changed' || data.type === 'program_media_groups_changed') {
        const normalizedProgramState = normalizeProgramState(data.state);
        syncProgramStateAndStagedScene(normalizedProgramState);
        if (data.type === 'program_media_groups_changed') {
          void fetchMediaGroups(activeProgramId);
        }
        return;
      }

      if (data.type === 'scene_staged') {
        const nextStagedSceneId = typeof data.stagedSceneId === 'number' ? data.stagedSceneId : null;
        setSelectedScene(nextStagedSceneId);
        setProgramState((previous) => {
          if (!previous) {
            return previous;
          }
          return {
            ...previous,
            stagedSceneId: nextStagedSceneId,
            stagedScene: data.scene && typeof data.scene === 'object' ? (data.scene as Scene) : null
          };
        });
        return;
      }

      if (data.type === 'scene_update') {
        if (data.scene && typeof data.scene === 'object') {
          applySceneUpdateLocally(data.scene as Scene);
        }
        return;
      }

      if (data.type === 'scene_cleared') {
        setProgramState((prev) => {
          if (!prev) {
            return prev;
          }
          return {
            ...prev,
            activeSceneId: null
          };
        });
        return;
      }

      if (data.type === 'audio_bus_update') {
        const nextMixerSource = data.settings && typeof data.settings === 'object' ? (data.settings as { mixerSettings?: unknown }).mixerSettings : undefined;
        if (nextMixerSource !== undefined) {
          const nextMixerLevels = normalizeBroadcastSettingsPayload(nextMixerSource);
          mixerLevelsRef.current = nextMixerLevels;
          setMixerLevels(nextMixerLevels);
        }
        const normalizedSongSequence = normalizeProgramSongPlaylist(
          normalizeProgramSongSequence(data?.settings?.songSequence) ?? { ...createProgramSongSequence('manual'), activeItemId: null }
        );
        setProgramAudioBusSettings({ songSequence: normalizedSongSequence });
        return;
      }

      if (data.type === 'audio_meter_update') {
        setProgramAudioMeterLevels((previous) => reconcileProgramAudioMeter(previous, normalizeProgramAudioMeter(data.levels)));
        return;
      }

      if (data.type === 'song_playback_update') {
        setProgramSongPlaybackState((previous) => reconcileProgramSongPlayback(previous, normalizeProgramSongPlayback(data.playback)));
        return;
      }

      if (data.type === 'scene_instant_state') {
        setSceneInstantPlayback(normalizeSceneInstantPlayback(data.playback));
        return;
      }

      if (data.type === 'scene_instant_take') {
        setSceneInstantPlayback({
          sceneId: normalizeSceneInstantId(data.sceneId),
          instantId: normalizeSceneInstantId(data.instant?.id),
          instantName: typeof data.instant?.name === 'string' ? data.instant.name : '',
          isPlaying: true,
          updatedAt: typeof data.triggeredAt === 'string' ? data.triggeredAt : new Date().toISOString()
        });
        return;
      }

      if (data.type === 'scene_instant_stop') {
        setSceneInstantPlayback((previous) => ({
          ...previous,
          isPlaying: false,
          updatedAt: typeof data.triggeredAt === 'string' ? data.triggeredAt : new Date().toISOString()
        }));
      }
    },
    [activeProgramId, applySceneUpdateLocally, isProgramRealtimeConnected, shouldApplyControlUpdatePayload, syncProgramStateAndStagedScene]
  );

  useSSE({
    url: apiUrl(`/program/${encodeURIComponent(activeProgramId)}/events`),
    onMessage: handleProgramEvent,
    enabled: !isProgramRealtimeConnected
  });

  const editableSceneComponentEntries = Object.entries(sceneEditorProps).filter(
    ([componentType]) => componentType !== 'chyron' && hasConfigurableSceneAttributes(componentType)
  );
  const stagedSceneData = selectedScene ? (assignedScenes.find((scene) => scene.id === selectedScene) ?? null) : null;
  const activeSceneId = programState?.activeSceneId ?? null;
  const selectedSceneInstantId = normalizeSceneInstantId(sceneEditorProps?.sceneInstant?.instantId);
  const selectedSceneInstant = selectedSceneInstantId ? (instants.find((instant) => instant.id === selectedSceneInstantId) ?? null) : null;
  const stagedIsOnAir = selectedScene !== null && selectedScene === activeSceneId;
  const programAudioBusSongSequence = useMemo(
    () =>
      normalizeProgramSongPlaylist(
        normalizeProgramSongSequence(programAudioBusSettings.songSequence) ?? { ...createProgramSongSequence('manual'), activeItemId: null }
      ),
    [programAudioBusSettings.songSequence]
  );
  const hasSoloChannel = mixerLevels.songSolo || mixerLevels.instantSolo || mixerLevels.sceneInstantSolo || mixerLevels.streamSolo;
  const streamAudible = (hasSoloChannel ? mixerLevels.streamSolo : true) && !mixerLevels.streamMuted;
  const songAudible = (hasSoloChannel ? mixerLevels.songSolo : true) && !mixerLevels.songMuted;
  const instantsAudible = (hasSoloChannel ? mixerLevels.instantSolo : true) && !mixerLevels.instantMuted;
  const sceneInstantAudible = (hasSoloChannel ? mixerLevels.sceneInstantSolo : true) && !mixerLevels.sceneInstantMuted;
  const mainMixGain = faderToGain(mixerLevels.mainMasterVolume);
  const songChannelGain = songAudible ? faderToGain(mixerLevels.songMasterVolume) : 0;
  const instantsChannelGain = instantsAudible ? faderToGain(mixerLevels.instantMasterVolume) : 0;
  const sceneInstantChannelGain = sceneInstantAudible ? faderToGain(mixerLevels.sceneInstantMasterVolume) : 0;
  const streamChannelGain = streamAudible ? faderToGain(mixerLevels.streamMasterVolume) : 0;
  const songOutputGain = songChannelGain * mainMixGain;
  const instantsOutputGain = instantsChannelGain * mainMixGain;
  const sceneInstantOutputGain = sceneInstantChannelGain * mainMixGain;
  const streamOutputGain = streamChannelGain * mainMixGain;
  const songPresetAFader = dbToFader(mixerTakePresetsDb.song.aDb);
  const songPresetBFader = dbToFader(mixerTakePresetsDb.song.bDb);
  const streamPresetAFader = dbToFader(mixerTakePresetsDb.stream.aDb);
  const streamPresetBFader = dbToFader(mixerTakePresetsDb.stream.bDb);
  const instantsPresetAFader = dbToFader(mixerTakePresetsDb.instants.aDb);
  const instantsPresetBFader = dbToFader(mixerTakePresetsDb.instants.bDb);
  const sceneInstantPresetAFader = dbToFader(mixerTakePresetsDb.sceneInstant.aDb);
  const sceneInstantPresetBFader = dbToFader(mixerTakePresetsDb.sceneInstant.bDb);
  const mainPresetAFader = dbToFader(mixerTakePresetsDb.main.aDb);
  const mainPresetBFader = dbToFader(mixerTakePresetsDb.main.bDb);
  const songTakeTargetSide = mixerTakeTargetSide.song;
  const streamTakeTargetSide = mixerTakeTargetSide.stream;
  const instantsTakeTargetSide = mixerTakeTargetSide.instants;
  const sceneInstantTakeTargetSide = mixerTakeTargetSide.sceneInstant;
  const mainTakeTargetSide = mixerTakeTargetSide.main;
  const activeSceneComponentTypes = (programState?.activeScene?.layout.componentType || '').split(',').filter(Boolean);
  const stagedSceneComponentTypes = (stagedSceneData?.layout.componentType || '').split(',').filter(Boolean);
  const shouldShowStreamStrip = activeSceneComponentTypes.includes('video-stream') || stagedSceneComponentTypes.includes('video-stream');
  const songMeterFill = meterLevelToFill(programAudioMeterLevels.song.vu);
  const songPeakFill = meterLevelToFill(programAudioMeterLevels.song.peak);
  const songPeakHoldFill = meterLevelToFill(programAudioMeterLevels.song.peakHold);
  const instantsMeterFill = meterLevelToFill(programAudioMeterLevels.instants.vu);
  const instantsPeakFill = meterLevelToFill(programAudioMeterLevels.instants.peak);
  const instantsPeakHoldFill = meterLevelToFill(programAudioMeterLevels.instants.peakHold);
  const sceneInstantMeterFill = meterLevelToFill(programAudioMeterLevels.sceneInstant.vu);
  const sceneInstantPeakFill = meterLevelToFill(programAudioMeterLevels.sceneInstant.peak);
  const sceneInstantPeakHoldFill = meterLevelToFill(programAudioMeterLevels.sceneInstant.peakHold);
  const mainMixMeterFill = meterLevelToFill(programAudioMeterLevels.main.vu);
  const mainMixPeakFill = meterLevelToFill(programAudioMeterLevels.main.peak);
  const mainMixPeakHoldFill = meterLevelToFill(programAudioMeterLevels.main.peakHold);
  const onlineStatusLabel = isProgramRealtimeConnected ? 'Realtime Online' : 'Fallback Mode';
  const onlineStatusTone = isProgramRealtimeConnected ? 'text-sea bg-sea/15 border-sea/40' : 'text-text-primary bg-accent-blue/15 border-accent-blue/35';
  const activeSongLabel = programSongPlaybackState.isPlaying && programSongPlaybackState.audioUrl ? 'Playing' : 'Idle';
  const controlDeckGrowProps = { grow: true } as any;
  return (
    <div className='flex h-full w-full min-h-0 flex-col bg-dark-sand text-text-primary'>
      <style>
        {`
          @keyframes ${INSTANT_PLAYBACK_SWEEP_ANIMATION} {
            0% { transform: scaleX(1); opacity: 0.26; }
            100% { transform: scaleX(0); opacity: 0.08; }
          }

          @keyframes ${SONG_PROGRESS_FILL_ANIMATION} {
            0% { transform: scaleX(0); }
            100% { transform: scaleX(1); }
          }

          @keyframes ${INSTANT_PLAYBACK_PULSE_ANIMATION} {
            0% { opacity: 0.12; }
            50% { opacity: 0.22; }
            100% { opacity: 0.12; }
          }
        `}
      </style>
      <div className='flex min-h-0 flex-1 overflow-y-auto pb-20'>
        <PanelLayout className='flex-1 min-h-0 w-full' padding='p-0'>
          <Panel title='Control Deck' accent='#38bdf8' className='min-w-0' {...controlDeckGrowProps}>
            {/* Main Control Accordion */}
            <Accordion
              className='h-full bg-transparent'
              defaultExpandedId='mixer'
              items={[
                {
                  id: 'mixer',
                  title: 'Mixer',
                  content: (
                    <div className='space-y-4'>
                      <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
                        {isLoadingMixerLevels ? (
                          <span className='text-xs font-mono text-amber-500 animate-pulse'>LOADING STATE...</span>
                        ) : isSavingMixerLevels ? (
                          <span className='text-xs font-mono text-emerald-500 animate-pulse'>STORING...</span>
                        ) : null}
                      </div>
                      <div className='rounded-xl border border-zinc-700 bg-zinc-900/70 p-4'>
                        <div className='flex flex-wrap items-end gap-3'>
                          <div className='min-w-[180px]'>
                            <p className='text-[11px] font-bold tracking-widest text-violet-300'>SCENE INSTANT CHANNEL</p>
                            <p className='mt-1 text-[11px] text-zinc-400'>Independent gain for scene-scoped background instant.</p>
                          </div>
                          <div className='flex gap-2'>
                            <Button
                              type='button'
                              onClick={toggleSceneInstantMuted}
                              className={`flex h-9 items-center justify-center rounded px-3 transition-all font-bold text-[11px] uppercase tracking-wider ${
                                mixerLevels.sceneInstantMuted
                                  ? 'bg-red-600 text-white shadow-[0_0_12px_rgba(220,38,38,0.5)]'
                                  : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-700 border border-zinc-700/50'
                              }`}
                            >
                              Mute
                            </Button>
                            <Button
                              type='button'
                              onClick={toggleSceneInstantSolo}
                              className={`flex h-9 items-center justify-center rounded px-3 transition-all font-bold text-[11px] uppercase tracking-wider ${
                                mixerLevels.sceneInstantSolo
                                  ? 'bg-yellow-500 text-yellow-950 shadow-[0_0_12px_rgba(234,179,8,0.4)]'
                                  : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-700 border border-zinc-700/50'
                              }`}
                            >
                              Solo
                            </Button>
                          </div>
                          <label className='text-[10px] font-mono text-sky-300'>
                            <span className='mb-1 block text-center'>A (dB)</span>
                            <Input
                              key={`scene-instant-preset-a-${mixerTakePresetsDb.sceneInstant.aDb}`}
                              type='text'
                              inputMode='decimal'
                              defaultValue={formatTakePresetDbInputValue(mixerTakePresetsDb.sceneInstant.aDb)}
                              onBlur={(event) => {
                                const nextValue = commitTakePresetDbInput('sceneInstant', 'a', event.target.value, mixerTakePresetsDb.sceneInstant.aDb);
                                event.target.value = formatTakePresetDbInputValue(nextValue);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.currentTarget.blur();
                                  return;
                                }
                                if (event.key === 'Escape') {
                                  event.currentTarget.value = formatTakePresetDbInputValue(mixerTakePresetsDb.sceneInstant.aDb);
                                  event.currentTarget.blur();
                                }
                              }}
                              className='w-20 rounded border border-sky-800/50 bg-zinc-900 px-1 py-1 text-center text-[10px] text-sky-200 outline-none focus:border-sky-400'
                            />
                          </label>
                          <label className='text-[10px] font-mono text-sky-300'>
                            <span className='mb-1 block text-center'>B (dB)</span>
                            <Input
                              key={`scene-instant-preset-b-${mixerTakePresetsDb.sceneInstant.bDb}`}
                              type='text'
                              inputMode='decimal'
                              defaultValue={formatTakePresetDbInputValue(mixerTakePresetsDb.sceneInstant.bDb)}
                              onBlur={(event) => {
                                const nextValue = commitTakePresetDbInput('sceneInstant', 'b', event.target.value, mixerTakePresetsDb.sceneInstant.bDb);
                                event.target.value = formatTakePresetDbInputValue(nextValue);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.currentTarget.blur();
                                  return;
                                }
                                if (event.key === 'Escape') {
                                  event.currentTarget.value = formatTakePresetDbInputValue(mixerTakePresetsDb.sceneInstant.bDb);
                                  event.currentTarget.blur();
                                }
                              }}
                              className='w-20 rounded border border-amber-800/50 bg-zinc-900 px-1 py-1 text-center text-[10px] text-amber-200 outline-none focus:border-amber-400'
                            />
                          </label>
                          <div className='h-9 w-36 self-end rounded bg-zinc-950'>
                            <Input
                              type='range'
                              min={0}
                              max={1}
                              step={0.01}
                              value={mixerLevels.sceneInstantMasterVolume}
                              onChange={(event) => setSceneInstantMasterVolume(Number(event.target.value))}
                              className='h-full w-full cursor-pointer'
                            />
                          </div>
                          <Input
                            key={`scene-instant-level-${mixerLevels.sceneInstantMasterVolume}`}
                            type='text'
                            inputMode='decimal'
                            defaultValue={formatMixerLevelInputValue(mixerLevels.sceneInstantMasterVolume)}
                            aria-label='Scene instant channel level in dB'
                            onBlur={(event) => {
                              const nextValue = parseMixerLevelInputToFader(event.target.value, mixerLevels.sceneInstantMasterVolume);
                              setSceneInstantMasterVolume(nextValue);
                              event.target.value = formatMixerLevelInputValue(nextValue);
                            }}
                            className='h-9 w-24 rounded border border-violet-900/40 bg-zinc-950 px-2 text-center font-mono text-sm font-bold text-violet-300 outline-none'
                          />
                          <Button
                            type='button'
                            onClick={() => triggerChannelTake('sceneInstant')}
                            disabled={isApplyingTakePresetByChannel.sceneInstant}
                            className='h-9 rounded border border-violet-800/50 bg-zinc-900 px-3 text-[10px] font-bold tracking-wider text-violet-300 transition hover:bg-violet-900/20 disabled:opacity-50'
                          >
                            TAKE {sceneInstantTakeTargetSide.toUpperCase()}
                          </Button>
                          <div className='min-w-[120px] text-right'>
                            <p className='text-[11px] text-zinc-400'>
                              Meter {Math.round(sceneInstantMeterFill * 100)}% / {Math.round(sceneInstantPeakFill * 100)}%
                            </p>
                            <p className='text-[11px] text-zinc-400'>
                              Peak Hold {Math.round(sceneInstantPeakHoldFill * 100)}% · {sceneInstantOutputGain > 0 ? 'LIVE' : 'CUT'}
                            </p>
                            <p className='text-[10px] text-zinc-500'>
                              A {Math.round(sceneInstantPresetAFader * 100)}% · B {Math.round(sceneInstantPresetBFader * 100)}%
                            </p>
                          </div>
                        </div>
                      </div>
                      <div className='flex gap-6 rounded-xl bg-zinc-900 border border-zinc-800 p-6 shadow-inner'>
                        {/* --- SCROLLABLE INPUTS SECTION --- */}
                        <div className='flex overflow-x-auto pb-4 custom-scrollbar flex-1'>
                          <div className='flex min-w-max items-stretch gap-4 pr-6'>
                            {/* --- SONG STRIP --- */}
                            <div className='flex w-36 flex-col items-center rounded-lg border border-zinc-700 bg-zinc-800/80 pb-6 shadow-xl shrink-0'>
                              <div className='w-full rounded-t-lg border-b border-zinc-700 bg-zinc-900 py-2.5 text-center shadow-sm'>
                                <span className='text-[11px] font-bold tracking-widest text-zinc-400'>SONG</span>
                              </div>

                              <div className='mt-5 flex w-full flex-col gap-2.5 px-5'>
                                <Button
                                  type='button'
                                  onClick={toggleSongMuted}
                                  className={`flex h-9 w-full items-center justify-center rounded transition-all font-bold text-[11px] uppercase tracking-wider ${
                                    mixerLevels.songMuted
                                      ? 'bg-red-600 text-white shadow-[0_0_12px_rgba(220,38,38,0.5)]'
                                      : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-700 border border-zinc-700/50'
                                  }`}
                                >
                                  Mute
                                </Button>
                                <Button
                                  type='button'
                                  onClick={toggleSongSolo}
                                  className={`flex h-9 w-full items-center justify-center rounded transition-all font-bold text-[11px] uppercase tracking-wider ${
                                    mixerLevels.songSolo
                                      ? 'bg-yellow-500 text-yellow-950 shadow-[0_0_12px_rgba(234,179,8,0.4)]'
                                      : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-700 border border-zinc-700/50'
                                  }`}
                                >
                                  Solo
                                </Button>
                              </div>
                              <div className='mt-2 grid w-full grid-cols-2 gap-2 px-5'>
                                <label className='text-[10px] font-mono text-sky-300'>
                                  <span className='mb-1 block text-center'>A</span>
                                  <Input
                                    key={`song-preset-a-${mixerTakePresetsDb.song.aDb}`}
                                    type='text'
                                    inputMode='decimal'
                                    defaultValue={formatTakePresetDbInputValue(mixerTakePresetsDb.song.aDb)}
                                    onBlur={(event) => {
                                      const nextValue = commitTakePresetDbInput('song', 'a', event.target.value, mixerTakePresetsDb.song.aDb);
                                      event.target.value = formatTakePresetDbInputValue(nextValue);
                                    }}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') {
                                        event.currentTarget.blur();
                                        return;
                                      }
                                      if (event.key === 'Escape') {
                                        event.currentTarget.value = formatTakePresetDbInputValue(mixerTakePresetsDb.song.aDb);
                                        event.currentTarget.blur();
                                      }
                                    }}
                                    className='w-full rounded border border-sky-800/50 bg-zinc-900 px-1 py-1 text-center text-[10px] text-sky-200 outline-none focus:border-sky-400'
                                  />
                                </label>
                                <label className='text-[10px] font-mono text-sky-300'>
                                  <span className='mb-1 block text-center'>B</span>
                                  <Input
                                    key={`song-preset-b-${mixerTakePresetsDb.song.bDb}`}
                                    type='text'
                                    inputMode='decimal'
                                    defaultValue={formatTakePresetDbInputValue(mixerTakePresetsDb.song.bDb)}
                                    onBlur={(event) => {
                                      const nextValue = commitTakePresetDbInput('song', 'b', event.target.value, mixerTakePresetsDb.song.bDb);
                                      event.target.value = formatTakePresetDbInputValue(nextValue);
                                    }}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') {
                                        event.currentTarget.blur();
                                        return;
                                      }
                                      if (event.key === 'Escape') {
                                        event.currentTarget.value = formatTakePresetDbInputValue(mixerTakePresetsDb.song.bDb);
                                        event.currentTarget.blur();
                                      }
                                    }}
                                    className='w-full rounded border border-amber-800/50 bg-zinc-900 px-1 py-1 text-center text-[10px] text-amber-200 outline-none focus:border-amber-400'
                                  />
                                </label>
                              </div>

                              <div className='relative mt-12 flex h-64 w-full justify-center px-4'>
                                <div className='absolute left-3 top-0 flex h-full flex-col justify-between text-right font-mono text-[9px] text-zinc-500'>
                                  <span className='translate-y-[-50%]'>10</span>
                                  <span className='translate-y-[-50%]'>5</span>
                                  <span className='translate-y-[-50%] font-bold text-zinc-300'>0</span>
                                  <span className='translate-y-[-50%]'>-5</span>
                                  <span className='translate-y-[-50%]'>-10</span>
                                  <span className='translate-y-[-50%]'>-20</span>
                                  <span className='translate-y-[-50%]'>-40</span>
                                  <span className='translate-y-[-50%]'>-∞</span>
                                </div>

                                <div className='ml-4 flex gap-3 h-full'>
                                  <div className='relative flex h-full w-2.5 flex-col justify-end overflow-hidden rounded bg-zinc-950 shadow-[inset_0_1px_3px_rgba(0,0,0,1)]'>
                                    <div
                                      className='pointer-events-none absolute left-0 right-0 h-[2px] bg-amber-200/90 transition-[bottom] duration-75 ease-linear'
                                      style={{ bottom: `${Math.round(songPeakFill * 100)}%` }}
                                    />
                                    <div
                                      className='pointer-events-none absolute left-0 right-0 h-[1px] bg-rose-400 transition-[bottom] duration-100 ease-linear'
                                      style={{ bottom: `${Math.round(songPeakHoldFill * 100)}%` }}
                                    />
                                    <div
                                      className='w-full bg-gradient-to-t from-emerald-500 via-amber-400 to-red-600 transition-[height] duration-75 ease-linear'
                                      style={{ height: `${Math.round(songMeterFill * 100)}%` }}
                                    />
                                  </div>

                                  <div className='relative h-full w-10 flex flex-col justify-center'>
                                    <div
                                      className='pointer-events-none absolute left-1/2 w-8 -translate-x-1/2 border-t border-sky-300/90'
                                      style={{ bottom: `${Math.round(songPresetAFader * 100)}%` }}
                                    />
                                    <span
                                      className='pointer-events-none absolute -right-3 text-[8px] font-bold text-sky-300'
                                      style={{ bottom: `calc(${Math.round(songPresetAFader * 100)}% - 6px)` }}
                                    >
                                      A
                                    </span>
                                    <div
                                      className='pointer-events-none absolute left-1/2 w-8 -translate-x-1/2 border-t border-sky-300/90'
                                      style={{ bottom: `${Math.round(songPresetBFader * 100)}%` }}
                                    />
                                    <span
                                      className='pointer-events-none absolute -right-3 text-[8px] font-bold text-sky-300'
                                      style={{ bottom: `calc(${Math.round(songPresetBFader * 100)}% - 6px)` }}
                                    >
                                      B
                                    </span>
                                    {/* Fader Track Line */}
                                    <div className='absolute left-1/2 top-0 h-full w-1.5 -translate-x-1/2 rounded-full bg-black shadow-[inset_0_1px_2px_rgba(255,255,255,0.1)]' />
                                    {/* Wrapper for rotation */}
                                    <div className='absolute top-1/2 left-1/2 flex items-center justify-center -translate-x-1/2 -translate-y-1/2 -rotate-90 w-64 h-10'>
                                      <Input
                                        type='range'
                                        min={0}
                                        max={1}
                                        step={0.01}
                                        value={mixerLevels.songMasterVolume}
                                        onChange={(event) => setSongMasterVolume(Number(event.target.value))}
                                        onMouseEnter={() => {
                                          document.body.style.overflow = 'hidden';
                                        }}
                                        onMouseLeave={() => {
                                          document.body.style.overflow = '';
                                        }}
                                        onWheel={(e) => {
                                          const step = 0.02;
                                          const delta = e.deltaY > 0 ? step : -step;
                                          setSongMasterVolume(Number(Math.max(0, Math.min(1, mixerLevels.songMasterVolume + delta)).toFixed(2)));
                                        }}
                                        className='w-full h-full cursor-grab appearance-none bg-transparent active:cursor-grabbing focus:outline-none [&::-webkit-slider-runnable-track]:h-full [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-10 [&::-webkit-slider-thumb]:w-14 [&::-webkit-slider-thumb]:rounded [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-zinc-800 [&::-webkit-slider-thumb]:bg-zinc-300 [&::-webkit-slider-thumb]:bg-gradient-to-b [&::-webkit-slider-thumb]:from-zinc-200 [&::-webkit-slider-thumb]:to-zinc-400 [&::-webkit-slider-thumb]:shadow-[0_4px_10px_rgba(0,0,0,0.5),inset_0_2px_0_rgba(255,255,255,0.8),-5px_0_0_rgba(150,150,150,0.4),0_0_0_rgba(150,150,150,0.4),5px_0_0_rgba(150,150,150,0.4)]'
                                      />
                                    </div>
                                  </div>
                                </div>
                              </div>

                              <div className='mt-10 flex h-14 w-4/5 flex-col justify-center rounded border border-[#1a3525] bg-[#0a1510] text-center shadow-inner'>
                                <Input
                                  key={`song-level-${mixerLevels.songMasterVolume}`}
                                  type='text'
                                  inputMode='decimal'
                                  defaultValue={formatMixerLevelInputValue(mixerLevels.songMasterVolume)}
                                  aria-label='Song channel level in dB'
                                  onBlur={(event) => {
                                    const nextValue = parseMixerLevelInputToFader(event.target.value, mixerLevels.songMasterVolume);
                                    setSongMasterVolume(nextValue);
                                    event.target.value = formatMixerLevelInputValue(nextValue);
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                      event.currentTarget.blur();
                                      return;
                                    }

                                    if (event.key === 'Escape') {
                                      event.currentTarget.value = formatMixerLevelInputValue(mixerLevels.songMasterVolume);
                                      event.currentTarget.blur();
                                    }
                                  }}
                                  className='w-full bg-transparent px-2 text-center font-mono text-sm font-bold text-emerald-500 outline-none'
                                />
                                <span className='font-mono text-[9px] tracking-wider text-emerald-700'>{songOutputGain > 0 ? 'LIVE' : 'CUT'}</span>
                              </div>
                              <Button
                                type='button'
                                onClick={() => triggerChannelTake('song')}
                                disabled={isApplyingTakePresetByChannel.song}
                                className='mt-2 w-4/5 rounded border border-sky-800/50 bg-zinc-900 py-1 text-[10px] font-bold tracking-wider text-sky-300 transition hover:bg-sky-900/20 disabled:opacity-50'
                              >
                                TAKE {songTakeTargetSide.toUpperCase()}
                              </Button>
                            </div>

                            {shouldShowStreamStrip ? (
                              <>
                                {/* --- STREAM STRIP --- */}
                                <div className='flex w-36 flex-col items-center rounded-lg border border-cyan-900/50 bg-zinc-800/80 pb-6 shadow-xl'>
                                  <div className='w-full rounded-t-lg border-b border-cyan-900/60 bg-cyan-950/20 py-2.5 text-center shadow-sm'>
                                    <span className='text-[11px] font-bold tracking-widest text-violet-300'>STREAM</span>
                                  </div>

                                  <div className='mt-5 flex w-full flex-col gap-2.5 px-5'>
                                    <Button
                                      type='button'
                                      onClick={toggleStreamMuted}
                                      className={`flex h-9 w-full items-center justify-center rounded transition-all font-bold text-[11px] uppercase tracking-wider ${
                                        mixerLevels.streamMuted
                                          ? 'bg-red-600 text-white shadow-[0_0_12px_rgba(220,38,38,0.5)]'
                                          : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-700 border border-zinc-700/50'
                                      }`}
                                    >
                                      Mute
                                    </Button>
                                    <Button
                                      type='button'
                                      onClick={toggleStreamSolo}
                                      className={`flex h-9 w-full items-center justify-center rounded transition-all font-bold text-[11px] uppercase tracking-wider ${
                                        mixerLevels.streamSolo
                                          ? 'bg-yellow-500 text-yellow-950 shadow-[0_0_12px_rgba(234,179,8,0.4)]'
                                          : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-700 border border-zinc-700/50'
                                      }`}
                                    >
                                      Solo
                                    </Button>
                                  </div>
                                  <div className='mt-2 grid w-full grid-cols-2 gap-2 px-5'>
                                    <label className='text-[10px] font-mono text-sky-300'>
                                      <span className='mb-1 block text-center'>A</span>
                                      <Input
                                        key={`stream-preset-a-${mixerTakePresetsDb.stream.aDb}`}
                                        type='text'
                                        inputMode='decimal'
                                        defaultValue={formatTakePresetDbInputValue(mixerTakePresetsDb.stream.aDb)}
                                        onBlur={(event) => {
                                          const nextValue = commitTakePresetDbInput('stream', 'a', event.target.value, mixerTakePresetsDb.stream.aDb);
                                          event.target.value = formatTakePresetDbInputValue(nextValue);
                                        }}
                                        onKeyDown={(event) => {
                                          if (event.key === 'Enter') {
                                            event.currentTarget.blur();
                                            return;
                                          }
                                          if (event.key === 'Escape') {
                                            event.currentTarget.value = formatTakePresetDbInputValue(mixerTakePresetsDb.stream.aDb);
                                            event.currentTarget.blur();
                                          }
                                        }}
                                        className='w-full rounded border border-sky-800/50 bg-zinc-900 px-1 py-1 text-center text-[10px] text-sky-200 outline-none focus:border-sky-400'
                                      />
                                    </label>
                                    <label className='text-[10px] font-mono text-sky-300'>
                                      <span className='mb-1 block text-center'>B</span>
                                      <Input
                                        key={`stream-preset-b-${mixerTakePresetsDb.stream.bDb}`}
                                        type='text'
                                        inputMode='decimal'
                                        defaultValue={formatTakePresetDbInputValue(mixerTakePresetsDb.stream.bDb)}
                                        onBlur={(event) => {
                                          const nextValue = commitTakePresetDbInput('stream', 'b', event.target.value, mixerTakePresetsDb.stream.bDb);
                                          event.target.value = formatTakePresetDbInputValue(nextValue);
                                        }}
                                        onKeyDown={(event) => {
                                          if (event.key === 'Enter') {
                                            event.currentTarget.blur();
                                            return;
                                          }
                                          if (event.key === 'Escape') {
                                            event.currentTarget.value = formatTakePresetDbInputValue(mixerTakePresetsDb.stream.bDb);
                                            event.currentTarget.blur();
                                          }
                                        }}
                                        className='w-full rounded border border-amber-800/50 bg-zinc-900 px-1 py-1 text-center text-[10px] text-amber-200 outline-none focus:border-amber-400'
                                      />
                                    </label>
                                  </div>

                                  <div className='relative mt-12 flex h-64 w-full justify-center px-4'>
                                    <div className='absolute left-3 top-0 flex h-full flex-col justify-between text-right font-mono text-[9px] text-zinc-500'>
                                      <span className='translate-y-[-50%]'>10</span>
                                      <span className='translate-y-[-50%]'>5</span>
                                      <span className='translate-y-[-50%] font-bold text-zinc-300'>0</span>
                                      <span className='translate-y-[-50%]'>-5</span>
                                      <span className='translate-y-[-50%]'>-10</span>
                                      <span className='translate-y-[-50%]'>-20</span>
                                      <span className='translate-y-[-50%]'>-40</span>
                                      <span className='translate-y-[-50%]'>-∞</span>
                                    </div>

                                    <div className='ml-4 flex gap-3 h-full'>
                                      <div className='relative flex h-full w-2.5 flex-col justify-end overflow-hidden rounded bg-zinc-950 shadow-[inset_0_1px_3px_rgba(0,0,0,1)]' />

                                      <div className='relative h-full w-10 flex flex-col justify-center'>
                                        <div
                                          className='pointer-events-none absolute left-1/2 w-8 -translate-x-1/2 border-t border-sky-300/90'
                                          style={{ bottom: `${Math.round(streamPresetAFader * 100)}%` }}
                                        />
                                        <span
                                          className='pointer-events-none absolute -right-3 text-[8px] font-bold text-sky-300'
                                          style={{ bottom: `calc(${Math.round(streamPresetAFader * 100)}% - 6px)` }}
                                        >
                                          A
                                        </span>
                                        <div
                                          className='pointer-events-none absolute left-1/2 w-8 -translate-x-1/2 border-t border-sky-300/90'
                                          style={{ bottom: `${Math.round(streamPresetBFader * 100)}%` }}
                                        />
                                        <span
                                          className='pointer-events-none absolute -right-3 text-[8px] font-bold text-sky-300'
                                          style={{ bottom: `calc(${Math.round(streamPresetBFader * 100)}% - 6px)` }}
                                        >
                                          B
                                        </span>
                                        <div className='absolute left-1/2 top-0 h-full w-1.5 -translate-x-1/2 rounded-full bg-black shadow-[inset_0_1px_2px_rgba(255,255,255,0.1)]' />
                                        <div className='absolute top-1/2 left-1/2 flex items-center justify-center -translate-x-1/2 -translate-y-1/2 -rotate-90 w-64 h-10'>
                                          <Input
                                            type='range'
                                            min={0}
                                            max={1}
                                            step={0.01}
                                            value={mixerLevels.streamMasterVolume}
                                            onChange={(event) => setStreamMasterVolume(Number(event.target.value))}
                                            onMouseEnter={() => {
                                              document.body.style.overflow = 'hidden';
                                            }}
                                            onMouseLeave={() => {
                                              document.body.style.overflow = '';
                                            }}
                                            onWheel={(e) => {
                                              const step = 0.02;
                                              const delta = e.deltaY > 0 ? step : -step;
                                              setStreamMasterVolume(Number(Math.max(0, Math.min(1, mixerLevels.streamMasterVolume + delta)).toFixed(2)));
                                            }}
                                            className='w-full h-full cursor-grab appearance-none bg-transparent active:cursor-grabbing focus:outline-none [&::-webkit-slider-runnable-track]:h-full [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-10 [&::-webkit-slider-thumb]:w-14 [&::-webkit-slider-thumb]:rounded [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-zinc-800 [&::-webkit-slider-thumb]:bg-zinc-300 [&::-webkit-slider-thumb]:bg-gradient-to-b [&::-webkit-slider-thumb]:from-zinc-200 [&::-webkit-slider-thumb]:to-zinc-400 [&::-webkit-slider-thumb]:shadow-[0_4px_10px_rgba(0,0,0,0.5),inset_0_2px_0_rgba(255,255,255,0.8),-5px_0_0_rgba(150,150,150,0.4),0_0_0_rgba(150,150,150,0.4),5px_0_0_rgba(150,150,150,0.4)]'
                                          />
                                        </div>
                                      </div>
                                    </div>
                                  </div>

                                  <div className='mt-10 flex h-14 w-4/5 flex-col justify-center rounded border border-cyan-900/30 bg-[#07161a] text-center shadow-inner'>
                                    <Input
                                      key={`stream-level-${mixerLevels.streamMasterVolume}`}
                                      type='text'
                                      inputMode='decimal'
                                      defaultValue={formatMixerLevelInputValue(mixerLevels.streamMasterVolume)}
                                      aria-label='Stream channel level in dB'
                                      onBlur={(event) => {
                                        const nextValue = parseMixerLevelInputToFader(event.target.value, mixerLevels.streamMasterVolume);
                                        setStreamMasterVolume(nextValue);
                                        event.target.value = formatMixerLevelInputValue(nextValue);
                                      }}
                                      onKeyDown={(event) => {
                                        if (event.key === 'Enter') {
                                          event.currentTarget.blur();
                                          return;
                                        }

                                        if (event.key === 'Escape') {
                                          event.currentTarget.value = formatMixerLevelInputValue(mixerLevels.streamMasterVolume);
                                          event.currentTarget.blur();
                                        }
                                      }}
                                      className='w-full bg-transparent px-2 text-center font-mono text-sm font-bold text-sky-300 outline-none'
                                    />
                                    <span className='font-mono text-[9px] tracking-wider text-sky-300'>{streamOutputGain > 0 ? 'LIVE' : 'CUT'}</span>
                                  </div>
                                  <Button
                                    type='button'
                                    onClick={() => triggerChannelTake('stream')}
                                    disabled={isApplyingTakePresetByChannel.stream}
                                    className='mt-2 w-4/5 rounded border border-cyan-800/50 bg-zinc-900 py-1 text-[10px] font-bold tracking-wider text-cyan-300 transition hover:bg-cyan-900/20 disabled:opacity-50'
                                  >
                                    TAKE {streamTakeTargetSide.toUpperCase()}
                                  </Button>
                                </div>
                              </>
                            ) : null}

                            {/* --- INSTANTS STRIP --- */}
                            <div className='flex w-36 flex-col items-center rounded-lg border border-zinc-700 bg-zinc-800/80 pb-6 shadow-xl'>
                              <div className='w-full rounded-t-lg border-b border-zinc-700 bg-zinc-900 py-2.5 text-center shadow-sm'>
                                <span className='text-[11px] font-bold tracking-widest text-zinc-400'>INSTANTS</span>
                              </div>

                              <div className='mt-5 flex w-full flex-col gap-2.5 px-5'>
                                <Button
                                  type='button'
                                  onClick={toggleInstantMuted}
                                  className={`flex h-9 w-full items-center justify-center rounded transition-all font-bold text-[11px] uppercase tracking-wider ${
                                    mixerLevels.instantMuted
                                      ? 'bg-red-600 text-white shadow-[0_0_12px_rgba(220,38,38,0.5)]'
                                      : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-700 border border-zinc-700/50'
                                  }`}
                                >
                                  Mute
                                </Button>
                                <Button
                                  type='button'
                                  onClick={toggleInstantSolo}
                                  className={`flex h-9 w-full items-center justify-center rounded transition-all font-bold text-[11px] uppercase tracking-wider ${
                                    mixerLevels.instantSolo
                                      ? 'bg-yellow-500 text-yellow-950 shadow-[0_0_12px_rgba(234,179,8,0.4)]'
                                      : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-700 border border-zinc-700/50'
                                  }`}
                                >
                                  Solo
                                </Button>
                              </div>
                              <div className='mt-2 grid w-full grid-cols-2 gap-2 px-5'>
                                <label className='text-[10px] font-mono text-sky-300'>
                                  <span className='mb-1 block text-center'>A</span>
                                  <Input
                                    key={`instants-preset-a-${mixerTakePresetsDb.instants.aDb}`}
                                    type='text'
                                    inputMode='decimal'
                                    defaultValue={formatTakePresetDbInputValue(mixerTakePresetsDb.instants.aDb)}
                                    onBlur={(event) => {
                                      const nextValue = commitTakePresetDbInput('instants', 'a', event.target.value, mixerTakePresetsDb.instants.aDb);
                                      event.target.value = formatTakePresetDbInputValue(nextValue);
                                    }}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') {
                                        event.currentTarget.blur();
                                        return;
                                      }
                                      if (event.key === 'Escape') {
                                        event.currentTarget.value = formatTakePresetDbInputValue(mixerTakePresetsDb.instants.aDb);
                                        event.currentTarget.blur();
                                      }
                                    }}
                                    className='w-full rounded border border-sky-800/50 bg-zinc-900 px-1 py-1 text-center text-[10px] text-sky-200 outline-none focus:border-sky-400'
                                  />
                                </label>
                                <label className='text-[10px] font-mono text-sky-300'>
                                  <span className='mb-1 block text-center'>B</span>
                                  <Input
                                    key={`instants-preset-b-${mixerTakePresetsDb.instants.bDb}`}
                                    type='text'
                                    inputMode='decimal'
                                    defaultValue={formatTakePresetDbInputValue(mixerTakePresetsDb.instants.bDb)}
                                    onBlur={(event) => {
                                      const nextValue = commitTakePresetDbInput('instants', 'b', event.target.value, mixerTakePresetsDb.instants.bDb);
                                      event.target.value = formatTakePresetDbInputValue(nextValue);
                                    }}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') {
                                        event.currentTarget.blur();
                                        return;
                                      }
                                      if (event.key === 'Escape') {
                                        event.currentTarget.value = formatTakePresetDbInputValue(mixerTakePresetsDb.instants.bDb);
                                        event.currentTarget.blur();
                                      }
                                    }}
                                    className='w-full rounded border border-amber-800/50 bg-zinc-900 px-1 py-1 text-center text-[10px] text-amber-200 outline-none focus:border-amber-400'
                                  />
                                </label>
                              </div>

                              <div className='relative mt-12 flex h-64 w-full justify-center px-4'>
                                <div className='absolute left-3 top-0 flex h-full flex-col justify-between text-right font-mono text-[9px] text-zinc-500'>
                                  <span className='translate-y-[-50%]'>10</span>
                                  <span className='translate-y-[-50%]'>5</span>
                                  <span className='translate-y-[-50%] font-bold text-zinc-300'>0</span>
                                  <span className='translate-y-[-50%]'>-5</span>
                                  <span className='translate-y-[-50%]'>-10</span>
                                  <span className='translate-y-[-50%]'>-20</span>
                                  <span className='translate-y-[-50%]'>-40</span>
                                  <span className='translate-y-[-50%]'>-∞</span>
                                </div>

                                <div className='ml-4 flex gap-3 h-full'>
                                  <div className='relative flex h-full w-2.5 flex-col justify-end overflow-hidden rounded bg-zinc-950 shadow-[inset_0_1px_3px_rgba(0,0,0,1)]'>
                                    <div
                                      className='pointer-events-none absolute left-0 right-0 h-[2px] bg-amber-200/90 transition-[bottom] duration-75 ease-linear'
                                      style={{ bottom: `${Math.round(instantsPeakFill * 100)}%` }}
                                    />
                                    <div
                                      className='pointer-events-none absolute left-0 right-0 h-[1px] bg-rose-400 transition-[bottom] duration-100 ease-linear'
                                      style={{ bottom: `${Math.round(instantsPeakHoldFill * 100)}%` }}
                                    />
                                    <div
                                      className='w-full bg-gradient-to-t from-emerald-500 via-amber-400 to-red-600 transition-[height] duration-75 ease-linear'
                                      style={{ height: `${Math.round(instantsMeterFill * 100)}%` }}
                                    />
                                  </div>

                                  <div className='relative h-full w-10 flex flex-col justify-center'>
                                    <div
                                      className='pointer-events-none absolute left-1/2 w-8 -translate-x-1/2 border-t border-sky-300/90'
                                      style={{ bottom: `${Math.round(instantsPresetAFader * 100)}%` }}
                                    />
                                    <span
                                      className='pointer-events-none absolute -right-3 text-[8px] font-bold text-sky-300'
                                      style={{ bottom: `calc(${Math.round(instantsPresetAFader * 100)}% - 6px)` }}
                                    >
                                      A
                                    </span>
                                    <div
                                      className='pointer-events-none absolute left-1/2 w-8 -translate-x-1/2 border-t border-sky-300/90'
                                      style={{ bottom: `${Math.round(instantsPresetBFader * 100)}%` }}
                                    />
                                    <span
                                      className='pointer-events-none absolute -right-3 text-[8px] font-bold text-sky-300'
                                      style={{ bottom: `calc(${Math.round(instantsPresetBFader * 100)}% - 6px)` }}
                                    >
                                      B
                                    </span>
                                    {/* Fader Track Line */}
                                    <div className='absolute left-1/2 top-0 h-full w-1.5 -translate-x-1/2 rounded-full bg-black shadow-[inset_0_1px_2px_rgba(255,255,255,0.1)]' />
                                    {/* Wrapper for rotation */}
                                    <div className='absolute top-1/2 left-1/2 flex items-center justify-center -translate-x-1/2 -translate-y-1/2 -rotate-90 w-64 h-10'>
                                      <Input
                                        type='range'
                                        min={0}
                                        max={1}
                                        step={0.01}
                                        value={mixerLevels.instantMasterVolume}
                                        onChange={(event) => setInstantMasterVolume(Number(event.target.value))}
                                        onMouseEnter={() => {
                                          document.body.style.overflow = 'hidden';
                                        }}
                                        onMouseLeave={() => {
                                          document.body.style.overflow = '';
                                        }}
                                        onWheel={(e) => {
                                          const step = 0.02;
                                          const delta = e.deltaY > 0 ? step : -step;
                                          setInstantMasterVolume(Number(Math.max(0, Math.min(1, mixerLevels.instantMasterVolume + delta)).toFixed(2)));
                                        }}
                                        className='w-full h-full cursor-grab appearance-none bg-transparent active:cursor-grabbing focus:outline-none [&::-webkit-slider-runnable-track]:h-full [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-10 [&::-webkit-slider-thumb]:w-14 [&::-webkit-slider-thumb]:rounded [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-zinc-800 [&::-webkit-slider-thumb]:bg-zinc-300 [&::-webkit-slider-thumb]:bg-gradient-to-b [&::-webkit-slider-thumb]:from-zinc-200 [&::-webkit-slider-thumb]:to-zinc-400 [&::-webkit-slider-thumb]:shadow-[0_4px_10px_rgba(0,0,0,0.5),inset_0_2px_0_rgba(255,255,255,0.8),-5px_0_0_rgba(150,150,150,0.4),0_0_0_rgba(150,150,150,0.4),5px_0_0_rgba(150,150,150,0.4)]'
                                      />
                                    </div>
                                  </div>
                                </div>
                              </div>

                              <div className='mt-10 flex h-14 w-4/5 flex-col justify-center rounded border border-[#1a3525] bg-[#0a1510] text-center shadow-inner'>
                                <Input
                                  key={`instants-level-${mixerLevels.instantMasterVolume}`}
                                  type='text'
                                  inputMode='decimal'
                                  defaultValue={formatMixerLevelInputValue(mixerLevels.instantMasterVolume)}
                                  aria-label='Instants channel level in dB'
                                  onBlur={(event) => {
                                    const nextValue = parseMixerLevelInputToFader(event.target.value, mixerLevels.instantMasterVolume);
                                    setInstantMasterVolume(nextValue);
                                    event.target.value = formatMixerLevelInputValue(nextValue);
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                      event.currentTarget.blur();
                                      return;
                                    }

                                    if (event.key === 'Escape') {
                                      event.currentTarget.value = formatMixerLevelInputValue(mixerLevels.instantMasterVolume);
                                      event.currentTarget.blur();
                                    }
                                  }}
                                  className='w-full bg-transparent px-2 text-center font-mono text-sm font-bold text-emerald-500 outline-none'
                                />
                                <span className='font-mono text-[9px] tracking-wider text-emerald-700'>{instantsOutputGain > 0 ? 'LIVE' : 'CUT'}</span>
                              </div>
                              <Button
                                type='button'
                                onClick={() => triggerChannelTake('instants')}
                                disabled={isApplyingTakePresetByChannel.instants}
                                className='mt-2 w-4/5 rounded border border-sky-800/50 bg-zinc-900 py-1 text-[10px] font-bold tracking-wider text-sky-300 transition hover:bg-sky-900/20 disabled:opacity-50'
                              >
                                TAKE {instantsTakeTargetSide.toUpperCase()}
                              </Button>
                            </div>
                          </div>
                        </div>

                        {/* --- MASTER STRIP (FIXED TO RIGHT) --- */}
                        <div className='flex w-44 flex-col items-center rounded-lg border border-red-900/30 bg-zinc-800 pb-6 shadow-2xl shrink-0'>
                          <div className='w-full rounded-t-lg border-b border-red-900/50 bg-red-950/20 py-2.5 text-center shadow-sm'>
                            <span className='text-[11px] font-bold tracking-widest text-red-500'>MAIN MIX</span>
                          </div>

                          <div className='mt-5 flex w-full flex-col gap-2.5 px-5'>
                            <div className='flex h-[82px] w-full flex-col justify-center rounded border border-red-900/20 bg-zinc-900/50 px-2 py-2 shadow-inner'>
                              <label className='text-[10px] font-mono text-red-300'>
                                <span className='mb-1 block text-center'>TAKE FADE (ms)</span>
                                <Input
                                  type='number'
                                  step={100}
                                  min={0}
                                  max={20000}
                                  value={takePresetFadeMs}
                                  onChange={(event) => setTakePresetFadeMs(normalizeTakeVolumeFadeMs(Number(event.target.value), takePresetFadeMs))}
                                  className='w-full rounded border border-red-900/50 bg-zinc-900 px-1 py-1 text-center text-[10px] text-red-200 outline-none focus:border-red-400'
                                />
                              </label>
                              <div className='mt-2 grid grid-cols-2 gap-2'>
                                <label className='text-[10px] font-mono text-sky-300'>
                                  <span className='mb-1 block text-center'>A</span>
                                  <Input
                                    key={`main-preset-a-${mixerTakePresetsDb.main.aDb}`}
                                    type='text'
                                    inputMode='decimal'
                                    defaultValue={formatTakePresetDbInputValue(mixerTakePresetsDb.main.aDb)}
                                    onBlur={(event) => {
                                      const nextValue = commitTakePresetDbInput('main', 'a', event.target.value, mixerTakePresetsDb.main.aDb);
                                      event.target.value = formatTakePresetDbInputValue(nextValue);
                                    }}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') {
                                        event.currentTarget.blur();
                                        return;
                                      }
                                      if (event.key === 'Escape') {
                                        event.currentTarget.value = formatTakePresetDbInputValue(mixerTakePresetsDb.main.aDb);
                                        event.currentTarget.blur();
                                      }
                                    }}
                                    className='w-full rounded border border-sky-800/50 bg-zinc-900 px-1 py-1 text-center text-[10px] text-sky-200 outline-none focus:border-sky-400'
                                  />
                                </label>
                                <label className='text-[10px] font-mono text-sky-300'>
                                  <span className='mb-1 block text-center'>B</span>
                                  <Input
                                    key={`main-preset-b-${mixerTakePresetsDb.main.bDb}`}
                                    type='text'
                                    inputMode='decimal'
                                    defaultValue={formatTakePresetDbInputValue(mixerTakePresetsDb.main.bDb)}
                                    onBlur={(event) => {
                                      const nextValue = commitTakePresetDbInput('main', 'b', event.target.value, mixerTakePresetsDb.main.bDb);
                                      event.target.value = formatTakePresetDbInputValue(nextValue);
                                    }}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') {
                                        event.currentTarget.blur();
                                        return;
                                      }
                                      if (event.key === 'Escape') {
                                        event.currentTarget.value = formatTakePresetDbInputValue(mixerTakePresetsDb.main.bDb);
                                        event.currentTarget.blur();
                                      }
                                    }}
                                    className='w-full rounded border border-amber-800/50 bg-zinc-900 px-1 py-1 text-center text-[10px] text-amber-200 outline-none focus:border-amber-400'
                                  />
                                </label>
                              </div>
                            </div>
                          </div>

                          <div className='relative mt-12 flex h-64 w-full justify-center px-4'>
                            <div className='absolute left-4 top-0 flex h-full flex-col justify-between text-right font-mono text-[9px] text-zinc-500'>
                              <span className='translate-y-[-50%] text-red-400'>10</span>
                              <span className='translate-y-[-50%] text-red-400'>5</span>
                              <span className='translate-y-[-50%] font-bold text-zinc-300'>0</span>
                              <span className='translate-y-[-50%]'>-5</span>
                              <span className='translate-y-[-50%]'>-10</span>
                              <span className='translate-y-[-50%]'>-20</span>
                              <span className='translate-y-[-50%]'>-40</span>
                              <span className='translate-y-[-50%]'>-∞</span>
                            </div>

                            <div className='ml-4 flex gap-4 h-full'>
                              <div className='flex gap-1 h-full'>
                                <div className='relative flex h-full w-2.5 flex-col justify-end overflow-hidden rounded bg-zinc-950 shadow-[inset_0_1px_3px_rgba(0,0,0,1)]'>
                                  <div
                                    className='pointer-events-none absolute left-0 right-0 h-[2px] bg-amber-200/90 transition-[bottom] duration-75 ease-linear'
                                    style={{ bottom: `${Math.round(mainMixPeakFill * 100)}%` }}
                                  />
                                  <div
                                    className='pointer-events-none absolute left-0 right-0 h-[1px] bg-rose-400 transition-[bottom] duration-100 ease-linear'
                                    style={{ bottom: `${Math.round(mainMixPeakHoldFill * 100)}%` }}
                                  />
                                  <div
                                    className='w-full bg-gradient-to-t from-emerald-500 via-amber-400 to-red-600 transition-[height] duration-75 ease-linear'
                                    style={{ height: `${Math.round(mainMixMeterFill * 100)}%` }}
                                  />
                                </div>
                                <div className='relative flex h-full w-2.5 flex-col justify-end overflow-hidden rounded bg-zinc-950 shadow-[inset_0_1px_3px_rgba(0,0,0,1)]'>
                                  <div
                                    className='pointer-events-none absolute left-0 right-0 h-[2px] bg-amber-200/90 transition-[bottom] duration-75 ease-linear'
                                    style={{ bottom: `${Math.round(mainMixPeakFill * 100)}%` }}
                                  />
                                  <div
                                    className='pointer-events-none absolute left-0 right-0 h-[1px] bg-rose-400 transition-[bottom] duration-100 ease-linear'
                                    style={{ bottom: `${Math.round(mainMixPeakHoldFill * 100)}%` }}
                                  />
                                  <div
                                    className='w-full bg-gradient-to-t from-emerald-500 via-amber-400 to-red-600 transition-[height] duration-75 ease-linear'
                                    style={{ height: `${Math.round(mainMixMeterFill * 100)}%` }}
                                  />
                                </div>
                              </div>

                              <div className='relative h-full w-10 flex flex-col justify-center'>
                                <div
                                  className='pointer-events-none absolute left-1/2 w-8 -translate-x-1/2 border-t border-sky-300/90'
                                  style={{ bottom: `${Math.round(mainPresetAFader * 100)}%` }}
                                />
                                <span
                                  className='pointer-events-none absolute -right-3 text-[8px] font-bold text-sky-300'
                                  style={{ bottom: `calc(${Math.round(mainPresetAFader * 100)}% - 6px)` }}
                                >
                                  A
                                </span>
                                <div
                                  className='pointer-events-none absolute left-1/2 w-8 -translate-x-1/2 border-t border-sky-300/90'
                                  style={{ bottom: `${Math.round(mainPresetBFader * 100)}%` }}
                                />
                                <span
                                  className='pointer-events-none absolute -right-3 text-[8px] font-bold text-sky-300'
                                  style={{ bottom: `calc(${Math.round(mainPresetBFader * 100)}% - 6px)` }}
                                >
                                  B
                                </span>
                                {/* Fader Track Line */}
                                <div className='absolute left-1/2 top-0 h-full w-2 -translate-x-1/2 rounded-full bg-black shadow-[inset_0_1px_2px_rgba(255,255,255,0.1)]' />
                                {/* Wrapper for rotation */}
                                <div className='absolute top-1/2 left-1/2 flex items-center justify-center -translate-x-1/2 -translate-y-1/2 -rotate-90 w-64 h-10'>
                                  <Input
                                    type='range'
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    value={mixerLevels.mainMasterVolume}
                                    onChange={(event) => setMainMasterVolume(Number(event.target.value))}
                                    onMouseEnter={() => {
                                      document.body.style.overflow = 'hidden';
                                    }}
                                    onMouseLeave={() => {
                                      document.body.style.overflow = '';
                                    }}
                                    onWheel={(e) => {
                                      const step = 0.02;
                                      const delta = e.deltaY > 0 ? step : -step;
                                      setMainMasterVolume(Number(Math.max(0, Math.min(1, mixerLevels.mainMasterVolume + delta)).toFixed(2)));
                                    }}
                                    className='w-full h-full cursor-grab appearance-none bg-transparent active:cursor-grabbing focus:outline-none [&::-webkit-slider-runnable-track]:h-full [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-10 [&::-webkit-slider-thumb]:w-14 [&::-webkit-slider-thumb]:rounded [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-red-950 [&::-webkit-slider-thumb]:bg-red-700 [&::-webkit-slider-thumb]:bg-gradient-to-b [&::-webkit-slider-thumb]:from-red-600 [&::-webkit-slider-thumb]:to-red-800 [&::-webkit-slider-thumb]:shadow-[0_4px_10px_rgba(0,0,0,0.5),inset_0_2px_0_rgba(255,255,255,0.4),-5px_0_0_rgba(100,0,0,0.5),0_0_0_rgba(100,0,0,0.5),5px_0_0_rgba(100,0,0,0.5)]'
                                  />
                                </div>
                              </div>
                            </div>
                          </div>

                          <div className='mt-10 flex h-14 w-4/5 flex-col justify-center rounded border border-red-950/50 bg-[#1a0a0a] text-center shadow-inner'>
                            <Input
                              key={`main-level-${mixerLevels.mainMasterVolume}`}
                              type='text'
                              inputMode='decimal'
                              defaultValue={formatMixerLevelInputValue(mixerLevels.mainMasterVolume)}
                              aria-label='Main mix level in dB'
                              onBlur={(event) => {
                                const nextValue = parseMixerLevelInputToFader(event.target.value, mixerLevels.mainMasterVolume);
                                setMainMasterVolume(nextValue);
                                event.target.value = formatMixerLevelInputValue(nextValue);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.currentTarget.blur();
                                  return;
                                }

                                if (event.key === 'Escape') {
                                  event.currentTarget.value = formatMixerLevelInputValue(mixerLevels.mainMasterVolume);
                                  event.currentTarget.blur();
                                }
                              }}
                              className='w-full bg-transparent px-2 text-center font-mono text-sm font-bold text-red-300 outline-none'
                            />
                            <span className='font-mono text-[9px] tracking-wider text-red-700'>{mainMixGain > 0 ? 'LIVE' : 'CUT'}</span>
                          </div>
                          <Button
                            type='button'
                            onClick={() => triggerChannelTake('main')}
                            disabled={isApplyingTakePresetByChannel.main}
                            className='mt-2 w-4/5 rounded border border-red-900/50 bg-zinc-900 py-1 text-[10px] font-bold tracking-wider text-red-300 transition hover:bg-red-900/20 disabled:opacity-50'
                          >
                            TAKE {mainTakeTargetSide.toUpperCase()}
                          </Button>
                        </div>
                      </div>

                      <p className='text-xs text-text-secondary dark:text-text-secondary'>
                        Solo follows mixer behavior: when any channel is soloed, non-soloed channels are cut. Main Mix applies after Song/Stream/Instants/Scene
                        Instant. Instant channel still controls all catalog instants together, while Scene Instant controls only scene background instant
                        playback.
                      </p>
                    </div>
                  )
                },
                {
                  id: 'scene-attributes',
                  title: 'Stage Attributes',
                  content: (
                    <div className='space-y-4'>
                      {!selectedScene ? (
                        <p className='text-sm text-text-secondary dark:text-text-secondary'>
                          Stage a scene above to edit its attributes before taking it live.
                        </p>
                      ) : (
                        <div
                          className='space-y-4'
                          onBlurCapture={(event) => {
                            if (selectedSceneRef.current !== null) {
                              void flushSceneAttributeAutosaveForScene(selectedSceneRef.current).catch(() => {
                                // no-op
                              });
                            }
                          }}
                        >
                          <div className='flex flex-wrap items-center justify-between gap-2'>
                            <p className='text-sm text-sea dark:text-accent-blue'>
                              Editing staged scene: {scenes.find((s) => s.id === selectedScene)?.name}
                              {stagedIsOnAir ? ' (ON AIR)' : ''}
                            </p>
                            <Button
                              size='sm'
                              variant='secondary'
                              onClick={() => {
                                void saveStagedSceneAttributes();
                              }}
                              disabled={!selectedScene || isSavingSceneAttributes}
                            >
                              {isSavingSceneAttributes ? 'SAVING…' : 'SAVE'}
                            </Button>
                          </div>
                          {activeProgramId === 'fifthbell' && (
                            <p className='text-xs text-text-secondary dark:text-text-secondary'>
                              FifthBell runtime settings are stored per component metadata (`fifthbell-content`, `fifthbell-marquee`, `fifthbell-clock` /
                              `toni-clock`).
                            </p>
                          )}
                          <div className='space-y-3 rounded-xl border border-sand/20 p-4 dark:border-sand/40'>
                            <div className='flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between'>
                              <div className='flex-1'>
                                <label className='block text-xs text-text-secondary mb-1'>Scene Background Instant</label>
                                <Select
                                  value={selectedSceneInstantId ? String(selectedSceneInstantId) : ''}
                                  onChange={(value) => {
                                    const nextInstantId = normalizeSceneInstantId(value);
                                    const currentSceneInstantProps =
                                      sceneEditorProps?.sceneInstant && typeof sceneEditorProps.sceneInstant === 'object' ? sceneEditorProps.sceneInstant : {};
                                    void commitSceneEditorComponentProps('sceneInstant', {
                                      ...currentSceneInstantProps,
                                      instantId: nextInstantId
                                    });
                                  }}
                                  className='w-full rounded border border-sand/40 px-3 py-2 text-sm focus:ring-2 focus:ring-sea/50'
                                  options={[
                                    { value: '', label: 'No background instant' },
                                    ...instants
                                      .filter((instant) => instant.enabled)
                                      .map((instant) => ({
                                        value: String(instant.id),
                                        label: instant.name
                                      }))
                                  ]}
                                />
                              </div>
                              <div className='flex flex-wrap gap-2'>
                                <Button
                                  size='sm'
                                  onClick={() => {
                                    void takeSceneInstant(selectedScene, selectedSceneInstantId);
                                  }}
                                  disabled={!selectedScene || selectedSceneInstantId === null || !selectedSceneInstant}
                                >
                                  TAKE BG
                                </Button>
                                <Button size='sm' variant='secondary' onClick={() => void stopSceneInstant()} disabled={!sceneInstantPlayback.isPlaying}>
                                  STOP BG
                                </Button>
                              </div>
                            </div>
                            <p className='text-xs text-text-secondary dark:text-text-secondary'>
                              {sceneInstantPlayback.isPlaying
                                ? `Playing: ${sceneInstantPlayback.instantName || 'Scene instant'}`
                                : selectedSceneInstant
                                  ? `Ready: ${selectedSceneInstant.name}`
                                  : 'Select an instant, then press SAVE (or TAKE BG).'}
                            </p>
                          </div>
                          <div className='space-y-4 rounded-xl border border-sand/20 p-4 dark:border-sand/40'>
                            {editableSceneComponentEntries.length === 0 && (
                              <p className='text-sm text-text-secondary dark:text-text-secondary'>No configurable component attributes for this scene.</p>
                            )}
                            {editableSceneComponentEntries.map(([componentType, props]) => {
                              const compInfo = componentTypes.find((ct) => ct.type === componentType);
                              return (
                                <div key={componentType} className='border-b border-sand/20 pb-4 last:border-b-0 dark:border-sand/40'>
                                  <h4 className='mb-2 text-md font-semibold text-text-primary dark:text-text-primary'>{compInfo?.name || componentType}</h4>
                                  <ComponentPropsFields
                                    componentType={componentType}
                                    props={props}
                                    updateProp={updateSceneEditorProp}
                                    replaceProps={replaceSceneEditorComponentProps}
                                    commitProps={commitSceneEditorComponentProps}
                                    songCatalog={songCatalog}
                                    mediaGroups={mediaGroups}
                                    isLoadingMediaGroups={isLoadingMediaGroups}
                                  />
                                  <ZIndexField componentType={componentType} props={props} updateProp={updateSceneEditorProp} />
                                </div>
                              );
                            })}
                          </div>
                          {isSavingSceneAttributes ? (
                            <p className='text-xs text-text-secondary dark:text-text-secondary text-right'>Autosaving scene attributes…</p>
                          ) : sceneAttributeSaveError ? (
                            <p className='text-xs text-terracotta text-right'>{sceneAttributeSaveError}</p>
                          ) : null}
                        </div>
                      )}
                    </div>
                  )
                }
              ]}
            />
          </Panel>

          <PanelColumn style={{ width: 520, minWidth: 520 }}>
            <Panel
              title='Playlist'
              accent='#8b5cf6'
              variant='monitor'
              className='flex-1 min-h-0 h-auto'
              toolbar={
                <div className='flex w-full items-center justify-start'>
                  <Button
                    size='sm'
                    variant='secondary'
                    onClick={() => {
                      setIsPlaylistSheetOpen(true);
                    }}
                  >
                    Add to Playlist
                  </Button>
                </div>
              }
            >
              <ProgramSongSequenceEditor
                sequence={programAudioBusSongSequence}
                songCatalog={songCatalog}
                programSongPlayback={programSongPlaybackState}
                view='queue'
                showPlaybackBar
                sceneQuickActions={assignedScenes.map((scene, index) => ({
                  id: scene.id,
                  name: scene.name,
                  isActive: activeSceneId === scene.id,
                  isStaged: selectedScene === scene.id,
                  shortcutLabel: String(index + 1)
                }))}
                onStageScene={(sceneId) => {
                  setSelectedScene(sceneId);
                  void stageSceneForProgram(sceneId);
                }}
                onTakeScene={(sceneId) => {
                  void activateScene(sceneId);
                }}
                onChange={(nextSequence) => {
                  void saveProgramAudioBusSongSequence(nextSequence);
                }}
                onTakeSelection={async (nextSequence) => {
                  await saveProgramAudioBusSongSequence(nextSequence);
                }}
                onTakeOffAir={async () => {
                  await takeProgramSongOffAir(activeProgramId);
                }}
                onStopAllInstants={() => void stopAllInstants()}
              />
            </Panel>
            <Panel
              title='Instants'
              accent='#f59e0b'
              variant='monitor'
              className='shrink-0 h-auto'
              toolbar={
                <div className='flex w-full items-center gap-2'>
                  <Input
                    type='text'
                    placeholder='Search instants…'
                    value={instantSearch}
                    onChange={(e) => setInstantSearch(e.target.value)}
                    className='min-w-0 flex-1 rounded border border-sand/30 bg-dark-sand/60 px-2 py-1 text-xs text-text-primary placeholder:text-text-secondary focus:border-accent-blue/60 focus:outline-none dark:border-sand/20 dark:bg-dark-sand/70 dark:text-text-primary dark:placeholder:text-text-secondary dark:focus:border-accent-blue/40'
                  />
                </div>
              }
            >
              <div className='p-3'>
                {isLoadingInstants ? (
                  <p className='text-sm text-text-secondary dark:text-text-secondary'>Loading instants...</p>
                ) : instants.length === 0 ? (
                  <p className='text-sm text-text-secondary dark:text-text-secondary'>No instants in catalog.</p>
                ) : (
                  (() => {
                    const filtered = instants.filter((i) => !instantSearch.trim() || i.name.toLowerCase().includes(instantSearch.trim().toLowerCase()));
                    return filtered.length === 0 ? (
                      <p className='text-sm text-text-secondary dark:text-text-secondary'>No instants match &ldquo;{instantSearch}&rdquo;.</p>
                    ) : (
                      <div className='grid grid-cols-2 gap-1.5'>
                        {filtered.map((instant) => {
                          const originalIndex = instants.indexOf(instant);
                          const playbackState = instantPlayback[instant.id] ?? null;
                          const isPlaying = playbackState !== null;
                          const shortcutLetter = getInstantShortcutLetter(originalIndex);

                          return (
                            <Button
                              key={instant.id}
                              type='button'
                              onClick={() => void triggerInstant(instant.id)}
                              disabled={!instant.enabled}
                              title={`${instant.name}${shortcutLetter ? ` (Ctrl+${shortcutLetter})` : ''}`}
                              className={`relative overflow-hidden rounded border px-1.5 py-2 text-left text-[11px] font-medium leading-tight transition-colors ${
                                !instant.enabled
                                  ? 'cursor-not-allowed border-sand/20 bg-sand/10 opacity-50 dark:border-sand/40'
                                  : isPlaying
                                    ? 'border-accent-blue/60 bg-accent-blue/15 text-text-primary ring-1 ring-accent-blue/30'
                                    : 'border-sand/25 bg-dark-sand/80 text-text-primary hover:border-accent-blue/40 hover:bg-accent-blue/10 dark:border-sand/20 dark:bg-dark-sand/70 dark:text-text-primary dark:hover:border-accent-blue/40'
                              }`}
                            >
                              {shortcutLetter ? <span className='mb-0.5 block font-mono text-[9px] opacity-40'>{shortcutLetter}</span> : null}
                              <span className='line-clamp-2'>{instant.name}</span>
                              {isPlaying ? (
                                <div className='pointer-events-none absolute inset-0 overflow-hidden rounded'>
                                  {playbackState && playbackState.endsAtMs !== null ? (
                                    <div
                                      key={`${instant.id}-${playbackState.startedAtMs}`}
                                      className='absolute inset-0 origin-left bg-accent-blue/20'
                                      style={{
                                        animation: `${INSTANT_PLAYBACK_SWEEP_ANIMATION} ${Math.max(200, playbackState.endsAtMs - playbackState.startedAtMs)}ms linear forwards`
                                      }}
                                    />
                                  ) : (
                                    <div
                                      className='absolute inset-0 bg-accent-blue/15'
                                      style={{
                                        animation: `${INSTANT_PLAYBACK_PULSE_ANIMATION} 1400ms ease-in-out infinite`
                                      }}
                                    />
                                  )}
                                </div>
                              ) : null}
                            </Button>
                          );
                        })}
                      </div>
                    );
                  })()
                )}
              </div>
            </Panel>
          </PanelColumn>
        </PanelLayout>
      </div>
      <Sheet
        isOpen={isPlaylistSheetOpen}
        onClose={() => {
          setIsPlaylistSheetOpen(false);
        }}
        side='right'
        className='w-full max-w-4xl'
        scrollContent={false}
      >
        <div className='h-full min-h-0'>
          <div className='mb-2 text-xs text-text-secondary dark:text-text-secondary'>{isSavingProgramAudioBus ? 'Saving…' : ''}</div>
          <ProgramSongSequenceEditor
            sequence={programAudioBusSongSequence}
            songCatalog={songCatalog}
            programSongPlayback={programSongPlaybackState}
            view='catalog'
            showPlaybackBar={false}
            onChange={(nextSequence) => {
              void saveProgramAudioBusSongSequence(nextSequence);
            }}
            onTakeSelection={async (nextSequence) => {
              await saveProgramAudioBusSongSequence(nextSequence);
            }}
            onTakeOffAir={async () => {
              await takeProgramSongOffAir(activeProgramId);
            }}
          />
        </div>
      </Sheet>
    </div>
  );
}

function ComponentPropsFields({
  componentType,
  props,
  updateProp,
  replaceProps,
  commitProps,
  songCatalog,
  mediaGroups,
  isLoadingMediaGroups
}: {
  componentType: string;
  props: any;
  updateProp: (componentType: string, propName: string, value: any) => void;
  replaceProps: (componentType: string, nextProps: any) => void;
  commitProps?: (componentType: string, nextProps: any) => Promise<void> | void;
  songCatalog: SongCatalogItem[];
  mediaGroups: MediaGroup[];
  isLoadingMediaGroups: boolean;
}) {
  const timezoneOptions = useMemo(() => {
    const baseDate = new Date();
    return getTimezonesSortedByOffset(baseDate).map((timezone) => ({
      value: timezone,
      label: getTimezoneOptionLabel(timezone, baseDate)
    }));
  }, []);
  const toBoolean = (value: unknown, fallback: boolean): boolean => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
    }
    return fallback;
  };

  switch (componentType) {
    case 'ticker':
      return (
        <div className='grid grid-cols-2 gap-3'>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Hashtag</label>
            <Input
              type='text'
              value={props.hashtag || ''}
              onChange={(e) => updateProp(componentType, 'hashtag', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='#Hashtag'
            />
          </div>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>URL</label>
            <Input
              type='text'
              value={props.url || ''}
              onChange={(e) => updateProp(componentType, 'url', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='website.com'
            />
          </div>
        </div>
      );
    case 'chyron':
      return (
        <div className='space-y-2'>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Text</label>
            <Input
              type='text'
              value={props.text || ''}
              onChange={(e) => updateProp(componentType, 'text', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='Chyron message'
            />
          </div>
        </div>
      );
    case 'header':
      return (
        <div className='grid grid-cols-2 gap-3'>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Title</label>
            <Input
              type='text'
              value={props.title || ''}
              onChange={(e) => updateProp(componentType, 'title', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='Program title'
            />
          </div>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Date</label>
            <Input
              type='text'
              value={props.date || ''}
              onChange={(e) => updateProp(componentType, 'date', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            />
          </div>
        </div>
      );
    case 'live-indicator':
      return (
        <div>
          <p className='text-xs text-text-secondary italic'>No configurable attributes. This component renders its SVG indicator.</p>
        </div>
      );
    case 'logo-widget':
      return (
        <div>
          <p className='text-xs text-text-secondary italic'>No configurable attributes. This component renders its SVG logo.</p>
        </div>
      );
    case 'slideshow':
      return (
        <SlideshowEditorFields
          componentType={componentType}
          props={props}
          updateProp={updateProp}
          mediaGroups={mediaGroups}
          isLoadingMediaGroups={isLoadingMediaGroups}
        />
      );
    case 'video-stream':
      return (
        <div className='space-y-3'>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Source URL</label>
            <Input
              type='text'
              value={props.sourceUrl || ''}
              onChange={(e) => updateProp(componentType, 'sourceUrl', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='https://example.com/stream.m3u8'
            />
          </div>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Poster URL (optional)</label>
            <Input
              type='text'
              value={props.posterUrl || ''}
              onChange={(e) => updateProp(componentType, 'posterUrl', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='https://example.com/poster.jpg'
            />
          </div>
          <div className='grid grid-cols-2 gap-3'>
            <label className='text-sm text-text-primary'>
              <span className='block text-xs text-text-secondary mb-1'>Fit Mode</span>
              <Select
                value={props.objectFit || 'cover'}
                onChange={(value) => updateProp(componentType, 'objectFit', value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                options={[
                  { value: 'cover', label: 'Cover' },
                  { value: 'contain', label: 'Contain' }
                ]}
              />
            </label>
          </div>
          <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
            <label className='flex items-center gap-2 text-sm text-text-primary'>
              <Input
                type='checkbox'
                checked={toBoolean(props.autoPlay, true)}
                onChange={(e) => updateProp(componentType, 'autoPlay', e.target.checked)}
                className='h-4 w-4'
              />
              Autoplay
            </label>
            <label className='flex items-center gap-2 text-sm text-text-primary'>
              <Input
                type='checkbox'
                checked={toBoolean(props.loop, false)}
                onChange={(e) => updateProp(componentType, 'loop', e.target.checked)}
                className='h-4 w-4'
              />
              Loop
            </label>
            <label className='flex items-center gap-2 text-sm text-text-primary'>
              <Input
                type='checkbox'
                checked={toBoolean(props.showControls, false)}
                onChange={(e) => updateProp(componentType, 'showControls', e.target.checked)}
                className='h-4 w-4'
              />
              Show Native Controls
            </label>
          </div>
          <p className='text-xs text-text-secondary'>Audio is controlled by mixer Song + Main faders (including mute/solo behavior).</p>
        </div>
      );
    case 'qr-code':
      return (
        <div>
          <label className='block text-xs text-text-secondary mb-1'>QR Code Content (URL or text)</label>
          <Input
            type='text'
            value={props.content || ''}
            onChange={(e) => updateProp(componentType, 'content', e.target.value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            placeholder='https://example.com'
          />
          <p className='text-xs text-text-secondary mt-1'>Enter URL or text to encode in QR code</p>
        </div>
      );
    case 'broadcast-layout':
      return (
        <div className='grid grid-cols-2 gap-3'>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Header Title</label>
            <Input
              type='text'
              value={props.headerTitle || ''}
              onChange={(e) => updateProp(componentType, 'headerTitle', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='Program title'
            />
          </div>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Hashtag</label>
            <Input
              type='text'
              value={props.hashtag || ''}
              onChange={(e) => updateProp(componentType, 'hashtag', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            />
          </div>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>URL</label>
            <Input
              type='text'
              value={props.url || ''}
              onChange={(e) => updateProp(componentType, 'url', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            />
          </div>
          <div className='col-span-2'>
            <label className='flex items-center gap-2 text-sm text-text-primary'>
              <Input
                type='checkbox'
                checked={toBoolean(props.showChyron, false)}
                onChange={(e) => updateProp(componentType, 'showChyron', e.target.checked)}
                className='h-4 w-4'
              />
              Show Chyron
            </label>
          </div>
          {toBoolean(props.showChyron, false) ? (
            <div className='col-span-2'>
              <label className='block text-xs text-text-secondary mb-1'>Chyron Text</label>
              <Input
                type='text'
                value={props.chyronText || ''}
                onChange={(e) => updateProp(componentType, 'chyronText', e.target.value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                placeholder='Optional lower chyron text'
              />
            </div>
          ) : null}
          <div className='col-span-2'>
            <label className='block text-xs text-text-secondary mb-1'>QR Code Content</label>
            <Input
              type='text'
              value={props.qrCodeContent || ''}
              onChange={(e) => updateProp(componentType, 'qrCodeContent', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='https://example.com'
            />
          </div>
          <div className='col-span-2'>
            <label className='block text-xs text-text-secondary mb-1'>Clock Timezone</label>
            <Select
              value={props.clockTimezone || 'America/Argentina/Buenos_Aires'}
              onChange={(value) => updateProp(componentType, 'clockTimezone', value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              options={timezoneOptions}
            />
          </div>
        </div>
      );
    case 'clock-widget':
      return (
        <div>
          <label className='block text-xs text-text-secondary mb-1'>Timezone</label>
          <Select
            value={props.timezone || 'America/Argentina/Buenos_Aires'}
            onChange={(value) => updateProp(componentType, 'timezone', value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            options={timezoneOptions}
          />
        </div>
      );
    case 'reloj-clock':
      return (
        <div>
          <label className='block text-xs text-text-secondary mb-1'>Timezone</label>
          <Select
            value={props.timezone || 'America/Argentina/Buenos_Aires'}
            onChange={(value) => updateProp(componentType, 'timezone', value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            options={timezoneOptions}
          />
        </div>
      );
    case 'reloj-loop-clock':
      return (
        <div className='space-y-2'>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Starting Timezone</label>
            <Select
              value={props.timezone || 'Europe/Madrid'}
              onChange={(value) => updateProp(componentType, 'timezone', value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              options={timezoneOptions}
            />
          </div>
          <p className='text-xs text-text-secondary'>Loop sequence: Madrid, Sanremo, New York, Santiago. Each timezone stays active for 30 seconds.</p>
        </div>
      );
    case 'reloj-digital-loop-clock':
      return (
        <RelojDigitalEditorFields
          componentType={componentType}
          props={props}
          updateProp={updateProp}
          replaceProps={replaceProps}
          commitProps={commitProps}
          timezoneOptions={timezoneOptions}
        />
      );
    case 'toni-chyron':
    case 'fifthbell-chyron':
      return (
        <ToniChyronEditorFields componentType={componentType} props={props} updateProp={updateProp} replaceProps={replaceProps} commitProps={commitProps} />
      );
    case 'modoitaliano-chyron':
      return (
        <ProgramChyronEditorFields componentType={componentType} props={props} updateProp={updateProp} replaceProps={replaceProps} commitProps={commitProps} />
      );
    case 'modoitaliano-clock':
      return null;
    case 'toni-clock':
    case 'fifthbell-clock': {
      const worldClockCitiesDefaultValue = JSON.stringify(Array.isArray(props.worldClockCities) ? props.worldClockCities : [], null, 2);
      const canToggleBellIcon = componentType === 'toni-clock';

      return (
        <div className='space-y-4'>
          <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'>
            <label className='flex items-center gap-2 text-sm text-text-primary'>
              <Input
                type='checkbox'
                checked={toBoolean(props.showWorldClocks, true)}
                onChange={(e) => updateProp(componentType, 'showWorldClocks', e.target.checked)}
                className='h-4 w-4'
              />
              Show World Clocks
            </label>
            {canToggleBellIcon ? (
              <label className='flex items-center gap-2 text-sm text-text-primary'>
                <Input
                  type='checkbox'
                  checked={toBoolean(props.showBellIcon, false)}
                  onChange={(e) => updateProp(componentType, 'showBellIcon', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Bell Icon
              </label>
            ) : (
              <div className='text-sm text-text-secondary'>FifthBell clock icon is always enabled.</div>
            )}
            <label className='flex items-center gap-2 text-sm text-text-primary'>
              <Input
                type='checkbox'
                checked={toBoolean(props.worldClockShuffle, false)}
                onChange={(e) => updateProp(componentType, 'worldClockShuffle', e.target.checked)}
                className='h-4 w-4'
              />
              Shuffle world clocks
            </label>
          </div>

          <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'>
            <label className='text-sm text-text-primary'>
              <span className='block text-xs text-text-secondary mb-1'>World clock rotate (ms)</span>
              <Input
                type='number'
                min={500}
                value={props.worldClockRotateIntervalMs ?? 5000}
                onChange={(e) => updateProp(componentType, 'worldClockRotateIntervalMs', Number(e.target.value))}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              />
            </label>
            <label className='text-sm text-text-primary'>
              <span className='block text-xs text-text-secondary mb-1'>World clock transition (ms)</span>
              <Input
                type='number'
                min={0}
                value={props.worldClockTransitionMs ?? 300}
                onChange={(e) => updateProp(componentType, 'worldClockTransitionMs', Number(e.target.value))}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              />
            </label>
            <label className='text-sm text-text-primary'>
              <span className='block text-xs text-text-secondary mb-1'>World clock width (px)</span>
              <Input
                type='number'
                min={120}
                value={props.worldClockWidthPx ?? 200}
                onChange={(e) => updateProp(componentType, 'worldClockWidthPx', Number(e.target.value))}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              />
            </label>
          </div>

          <div className='space-y-2'>
            <label className='block text-xs text-text-secondary'>World Clock Cities JSON</label>
            <Textarea
              defaultValue={worldClockCitiesDefaultValue}
              onBlur={(e) => {
                if (!e.target.value.trim()) {
                  updateProp(componentType, 'worldClockCities', []);
                  return;
                }

                try {
                  const parsed = JSON.parse(e.target.value);
                  if (!Array.isArray(parsed)) {
                    return;
                  }

                  const normalized = parsed
                    .map((item) => {
                      if (!item || typeof item !== 'object' || Array.isArray(item)) {
                        return null;
                      }
                      const city = typeof item.city === 'string' ? item.city.trim() : '';
                      const timezone = typeof item.timezone === 'string' ? item.timezone.trim() : '';
                      if (!city || !timezone) {
                        return null;
                      }
                      return { city, timezone };
                    })
                    .filter((item): item is { city: string; timezone: string } => item !== null);

                  updateProp(componentType, 'worldClockCities', normalized);
                } catch (error) {
                  console.error('Invalid ToniClock worldClockCities JSON:', error);
                }
              }}
              rows={6}
              className='w-full px-3 py-2 text-sm border rounded font-mono focus:ring-2 focus:ring-sea/50'
            />
            <p className='text-xs text-text-secondary'>Each item must be {'{ \"city\": \"SANREMO\", \"timezone\": \"Europe/Rome\" }'}.</p>
          </div>
        </div>
      );
    }
    case 'modoitaliano-disclaimer':
      return (
        <div className='space-y-3'>
          <p className='text-xs text-text-secondary'>Shown only when ModoItaliano chyron is hidden/empty.</p>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Text</label>
            <Input
              type='text'
              value={props.text || ''}
              onChange={(e) => updateProp(componentType, 'text', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='Disclaimer text'
            />
          </div>
          <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3'>
            <label className='flex items-center gap-2 text-sm text-text-primary'>
              <Input
                type='checkbox'
                checked={toBoolean(props.show, true)}
                onChange={(e) => updateProp(componentType, 'show', e.target.checked)}
                className='h-4 w-4'
              />
              Show Disclaimer
            </label>
            <label className='text-sm text-text-primary'>
              <span className='block text-xs text-text-secondary mb-1'>Alignment</span>
              <Select
                value={props.align || 'right'}
                onChange={(value) => updateProp(componentType, 'align', value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                options={[
                  { value: 'left', label: 'Left' },
                  { value: 'center', label: 'Center' },
                  { value: 'right', label: 'Right' }
                ]}
              />
            </label>
            <label className='text-sm text-text-primary'>
              <span className='block text-xs text-text-secondary mb-1'>Bottom (px)</span>
              <Input
                type='number'
                min={0}
                value={props.bottomPx ?? 24}
                onChange={(e) => updateProp(componentType, 'bottomPx', Number(e.target.value))}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              />
            </label>
            <label className='text-sm text-text-primary'>
              <span className='block text-xs text-text-secondary mb-1'>Font Size (px)</span>
              <Input
                type='number'
                min={10}
                value={props.fontSizePx ?? 20}
                onChange={(e) => updateProp(componentType, 'fontSizePx', Number(e.target.value))}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              />
            </label>
          </div>
          <label className='text-sm text-text-primary block max-w-xs'>
            <span className='block text-xs text-text-secondary mb-1'>Opacity (0-1)</span>
            <Input
              type='number'
              min={0}
              max={1}
              step={0.05}
              value={props.opacity ?? 0.82}
              onChange={(e) => updateProp(componentType, 'opacity', Number(e.target.value))}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            />
          </label>
        </div>
      );
    case 'cronica-background':
      return <p className='text-xs text-text-secondary italic'>No configurable fields for Cronica background.</p>;
    case 'cronica-chyron':
      return (
        <div className='space-y-3'>
          <label className='block text-sm text-text-primary'>
            Text (Multi-line supported)
            <Textarea
              value={props.text || ''}
              onChange={(e) => updateProp(componentType, 'text', e.target.value)}
              className='mt-1 w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50 h-24'
              placeholder='Enter chyron text...'
            />
          </label>
        </div>
      );
    case 'cronica-reiteramos':
      return (
        <div className='space-y-3'>
          <label className='block text-sm text-text-primary'>
            Text
            <Input
              type='text'
              value={props.text || 'REITERAMOS'}
              onChange={(e) => updateProp(componentType, 'text', e.target.value)}
              className='mt-1 w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            />
          </label>
          <label className='flex items-center gap-2 text-sm text-text-primary'>
            <Input
              type='checkbox'
              checked={toBoolean(props.show, true)}
              onChange={(e) => updateProp(componentType, 'show', e.target.checked)}
              className='h-4 w-4 text-sea focus:ring-sea/50 border-sand/40 rounded'
            />
            Show banner
          </label>
        </div>
      );
    case 'toni-logo':
      return <p className='text-xs text-text-secondary italic'>Logo cycles automatically between station images.</p>;
    case 'earone':
      return (
        <div className='space-y-2'>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Label</label>
            <Input
              type='text'
              value={props.label || 'EARONE'}
              onChange={(e) => updateProp(componentType, 'label', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='EARONE'
            />
          </div>
          <div className='grid grid-cols-2 gap-3'>
            <div>
              <label className='block text-xs text-text-secondary mb-1'>Rank</label>
              <Input
                type='text'
                value={props.rank || ''}
                onChange={(e) => updateProp(componentType, 'rank', e.target.value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                placeholder='Uses active sequence item'
              />
            </div>
            <div>
              <label className='block text-xs text-text-secondary mb-1'>Spins Today</label>
              <Input
                type='text'
                value={props.spins || ''}
                onChange={(e) => updateProp(componentType, 'spins', e.target.value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                placeholder='Uses active sequence item'
              />
            </div>
          </div>
          <p className='text-xs text-text-secondary'>Leave rank/spins blank to follow the active Toni chyron sequence item.</p>
        </div>
      );
    case 'fifthbell':
    case 'fifthbell-content':
    case 'fifthbell-marquee':
    case 'fifthbell-corner': {
      const supportsContent = componentType === 'fifthbell' || componentType === 'fifthbell-content';
      const supportsMarquee = componentType === 'fifthbell' || componentType === 'fifthbell-marquee';
      const supportsCorner = componentType === 'fifthbell' || componentType === 'fifthbell-corner';
      const selectedWeatherCities = Array.isArray(props.weatherCities)
        ? props.weatherCities.filter((city: unknown): city is string => typeof city === 'string')
        : [];
      const selectedCitySet = new Set(selectedWeatherCities);
      const languageRotation = Array.isArray(props.languageRotation)
        ? props.languageRotation.filter((lang: unknown): lang is string => typeof lang === 'string')
        : ['en', 'es', 'en', 'it'];
      const worldClockCitiesDefaultValue = JSON.stringify(Array.isArray(props.worldClockCities) ? props.worldClockCities : [], null, 2);

      return (
        <div className='space-y-4'>
          <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'>
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-text-primary'>
                <Input
                  type='checkbox'
                  checked={toBoolean(props.showArticles, true)}
                  onChange={(e) => updateProp(componentType, 'showArticles', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Articles
              </label>
            )}
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-text-primary'>
                <Input
                  type='checkbox'
                  checked={toBoolean(props.showWeather, true)}
                  onChange={(e) => updateProp(componentType, 'showWeather', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Weather
              </label>
            )}
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-text-primary'>
                <Input
                  type='checkbox'
                  checked={toBoolean(props.showEarthquakes, true)}
                  onChange={(e) => updateProp(componentType, 'showEarthquakes', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Earthquakes
              </label>
            )}
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-text-primary'>
                <Input
                  type='checkbox'
                  checked={toBoolean(props.showMarkets, true)}
                  onChange={(e) => updateProp(componentType, 'showMarkets', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Markets
              </label>
            )}
            {supportsMarquee && (
              <label className='flex items-center gap-2 text-sm text-text-primary'>
                <Input
                  type='checkbox'
                  checked={toBoolean(props.showMarquee, false)}
                  onChange={(e) => updateProp(componentType, 'showMarquee', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Bottom Marquee
              </label>
            )}
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-text-primary'>
                <Input
                  type='checkbox'
                  checked={toBoolean(props.showCallsignTake, true)}
                  onChange={(e) => updateProp(componentType, 'showCallsignTake', e.target.checked)}
                  className='h-4 w-4'
                />
                Enable Callsign Take
              </label>
            )}
            {supportsCorner && (
              <label className='flex items-center gap-2 text-sm text-text-primary'>
                <Input
                  type='checkbox'
                  checked={toBoolean(props.showWorldClocks, true)}
                  onChange={(e) => updateProp(componentType, 'showWorldClocks', e.target.checked)}
                  className='h-4 w-4'
                />
                Show World Clocks
              </label>
            )}
            {supportsCorner && <div className='text-sm text-text-secondary'>FifthBell clock icon is always enabled.</div>}
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-text-primary'>
                <Input
                  type='checkbox'
                  checked={toBoolean(props.audioCueEnabled, true)}
                  onChange={(e) => updateProp(componentType, 'audioCueEnabled', e.target.checked)}
                  className='h-4 w-4'
                />
                Enable Audio Cue
              </label>
            )}
            {supportsCorner && (
              <label className='flex items-center gap-2 text-sm text-text-primary'>
                <Input
                  type='checkbox'
                  checked={toBoolean(props.worldClockShuffle, true)}
                  onChange={(e) => updateProp(componentType, 'worldClockShuffle', e.target.checked)}
                  className='h-4 w-4'
                />
                Shuffle world clocks
              </label>
            )}
          </div>

          <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'>
            {supportsContent && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Data load timeout (ms)</span>
                <Input
                  type='number'
                  min={1000}
                  value={props.dataLoadTimeoutMs ?? 15000}
                  onChange={(e) => updateProp(componentType, 'dataLoadTimeoutMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Playlist default duration (ms)</span>
                <Input
                  type='number'
                  min={1000}
                  value={props.playlistDefaultDurationMs ?? 10000}
                  onChange={(e) => updateProp(componentType, 'playlistDefaultDurationMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Playlist update interval (ms)</span>
                <Input
                  type='number'
                  min={16}
                  value={props.playlistUpdateIntervalMs ?? 100}
                  onChange={(e) => updateProp(componentType, 'playlistUpdateIntervalMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Articles duration (ms)</span>
                <Input
                  type='number'
                  min={1000}
                  value={props.articlesDurationMs ?? 10000}
                  onChange={(e) => updateProp(componentType, 'articlesDurationMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Weather duration (ms)</span>
                <Input
                  type='number'
                  min={1000}
                  value={props.weatherDurationMs ?? 5000}
                  onChange={(e) => updateProp(componentType, 'weatherDurationMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Earthquakes duration (ms)</span>
                <Input
                  type='number'
                  min={1000}
                  value={props.earthquakesDurationMs ?? 10000}
                  onChange={(e) => updateProp(componentType, 'earthquakesDurationMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Markets duration (ms)</span>
                <Input
                  type='number'
                  min={1000}
                  value={props.marketsDurationMs ?? 10000}
                  onChange={(e) => updateProp(componentType, 'marketsDurationMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsCorner && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>World clock rotate (ms)</span>
                <Input
                  type='number'
                  min={500}
                  value={props.worldClockRotateIntervalMs ?? 7000}
                  onChange={(e) => updateProp(componentType, 'worldClockRotateIntervalMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsCorner && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>World clock transition (ms)</span>
                <Input
                  type='number'
                  min={0}
                  value={props.worldClockTransitionMs ?? 300}
                  onChange={(e) => updateProp(componentType, 'worldClockTransitionMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsCorner && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>World clock width (px)</span>
                <Input
                  type='number'
                  min={120}
                  value={props.worldClockWidthPx ?? 200}
                  onChange={(e) => updateProp(componentType, 'worldClockWidthPx', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Audio cue minute</span>
                <Input
                  type='number'
                  min={0}
                  max={59}
                  value={props.audioCueMinute ?? 59}
                  onChange={(e) => updateProp(componentType, 'audioCueMinute', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Audio cue second</span>
                <Input
                  type='number'
                  min={0}
                  max={59}
                  value={props.audioCueSecond ?? 55}
                  onChange={(e) => updateProp(componentType, 'audioCueSecond', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Callsign prelaunch until (NYC ISO)</span>
                <Input
                  type='text'
                  value={props.callsignPrelaunchUntilNyc ?? '2026-01-02T21:30:00'}
                  onChange={(e) => updateProp(componentType, 'callsignPrelaunchUntilNyc', e.target.value)}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                  placeholder='2026-01-02T21:30:00'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Callsign window start sec (:59)</span>
                <Input
                  type='number'
                  min={0}
                  max={59}
                  value={props.callsignWindowStartSecond ?? 50}
                  onChange={(e) => updateProp(componentType, 'callsignWindowStartSecond', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Callsign window end sec (:00)</span>
                <Input
                  type='number'
                  min={0}
                  max={59}
                  value={props.callsignWindowEndSecond ?? 3}
                  onChange={(e) => updateProp(componentType, 'callsignWindowEndSecond', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsMarquee && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Marquee min posts</span>
                <Input
                  type='number'
                  min={0}
                  value={props.marqueeMinPostsCount ?? 4}
                  onChange={(e) => updateProp(componentType, 'marqueeMinPostsCount', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsMarquee && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Marquee min average relevance</span>
                <Input
                  type='number'
                  min={0}
                  value={props.marqueeMinAverageRelevance ?? 0}
                  onChange={(e) => updateProp(componentType, 'marqueeMinAverageRelevance', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsMarquee && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Marquee min median relevance</span>
                <Input
                  type='number'
                  min={0}
                  value={props.marqueeMinMedianRelevance ?? 0}
                  onChange={(e) => updateProp(componentType, 'marqueeMinMedianRelevance', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsMarquee && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Marquee px/sec</span>
                <Input
                  type='number'
                  min={10}
                  value={props.marqueePixelsPerSecond ?? 150}
                  onChange={(e) => updateProp(componentType, 'marqueePixelsPerSecond', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsMarquee && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Marquee min duration (sec)</span>
                <Input
                  type='number'
                  min={1}
                  value={props.marqueeMinDurationSeconds ?? 10}
                  onChange={(e) => updateProp(componentType, 'marqueeMinDurationSeconds', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsMarquee && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Marquee height (px)</span>
                <Input
                  type='number'
                  min={72}
                  value={props.marqueeHeightPx ?? 72}
                  onChange={(e) => updateProp(componentType, 'marqueeHeightPx', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
          </div>
          {supportsMarquee && (
            <p className='text-xs text-text-secondary'>Marquee thresholds are minimums. Set any of them to `0` to disable that specific filter.</p>
          )}

          {supportsContent && (
            <div className='space-y-2'>
              <label className='block text-xs text-text-secondary'>Language Rotation (comma-separated: en, es, it)</label>
              <Input
                type='text'
                defaultValue={languageRotation.join(', ')}
                onBlur={(e) => {
                  const next = e.target.value
                    .split(',')
                    .map((lang) => lang.trim().toLowerCase())
                    .filter((lang) => ['en', 'es', 'it'].includes(lang));
                  updateProp(componentType, 'languageRotation', next.length > 0 ? next : ['en']);
                }}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              />
            </div>
          )}

          {supportsContent && (
            <div>
              <h3 className='text-sm font-semibold text-text-primary mb-2'>Weather Cities</h3>
              <p className='text-xs text-text-secondary mb-2'>If none are selected, all cities are shown in the weather segment.</p>
              <div className='grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 max-h-64 overflow-auto border rounded p-3 bg-dark-sand/60'>
                {FIFTHBELL_AVAILABLE_WEATHER_CITIES.map((city) => (
                  <label key={city} className='flex items-center gap-2 text-sm text-text-primary'>
                    <Input
                      type='checkbox'
                      checked={selectedCitySet.has(city)}
                      onChange={(e) => {
                        const next = new Set(selectedWeatherCities);
                        if (e.target.checked) {
                          next.add(city);
                        } else {
                          next.delete(city);
                        }
                        updateProp(componentType, 'weatherCities', [...next]);
                      }}
                      className='h-4 w-4'
                    />
                    {city}
                  </label>
                ))}
              </div>
            </div>
          )}

          {supportsCorner && (
            <div className='space-y-2'>
              <label className='block text-xs text-text-secondary'>World Clock Cities JSON (optional override)</label>
              <Textarea
                defaultValue={worldClockCitiesDefaultValue}
                onBlur={(e) => {
                  if (!e.target.value.trim()) {
                    updateProp(componentType, 'worldClockCities', []);
                    return;
                  }

                  try {
                    const parsed = JSON.parse(e.target.value);
                    if (!Array.isArray(parsed)) {
                      return;
                    }

                    const normalized = parsed
                      .map((item) => {
                        if (!item || typeof item !== 'object' || Array.isArray(item)) {
                          return null;
                        }
                        const city = typeof item.city === 'string' ? item.city.trim() : '';
                        const timezone = typeof item.timezone === 'string' ? item.timezone.trim() : '';
                        if (!city || !timezone) {
                          return null;
                        }
                        return { city, timezone };
                      })
                      .filter((item): item is { city: string; timezone: string } => item !== null);

                    updateProp(componentType, 'worldClockCities', normalized);
                  } catch (error) {
                    console.error('Invalid FifthBell worldClockCities JSON:', error);
                  }
                }}
                rows={6}
                className='w-full px-3 py-2 text-sm border rounded font-mono focus:ring-2 focus:ring-sea/50'
              />
              <p className='text-xs text-text-secondary'>Each item must be {'{ \"city\": \"NEW YORK\", \"timezone\": \"America/New_York\" }'}.</p>
            </div>
          )}
        </div>
      );
    }
    default:
      return <div className='text-xs text-text-secondary italic'>Default configuration</div>;
  }
}

function ZIndexField({
  componentType,
  props,
  updateProp
}: {
  componentType: string;
  props: any;
  updateProp: (componentType: string, propName: string, value: any) => void;
}) {
  return (
    <div className='mt-3 border-t border-sand/20 pt-3'>
      <label className='block text-xs text-text-secondary mb-1'>Layer (z-index)</label>
      <Input
        type='number'
        value={typeof props._zIndex === 'number' ? props._zIndex : ''}
        onChange={(e) => {
          const val = e.target.value.trim();
          updateProp(componentType, '_zIndex', val === '' ? undefined : Number(val));
        }}
        className='w-28 px-3 py-1.5 text-sm border rounded focus:ring-2 focus:ring-sea/50'
        placeholder='auto'
      />
      <p className='mt-1 text-[10px] text-text-secondary'>Higher numbers appear in front. Leave blank for default DOM order.</p>
    </div>
  );
}

function ToniChyronEditorFields({
  componentType,
  props,
  updateProp,
  replaceProps,
  commitProps
}: {
  componentType: string;
  props: any;
  updateProp: (componentType: string, propName: string, value: any) => void;
  replaceProps: (componentType: string, nextProps: any) => void;
  commitProps?: (componentType: string, nextProps: any) => Promise<void> | void;
}) {
  const normalizedSequence = normalizeToniChyronSequence(props.sequence);
  const contentMode = getToniChyronContentMode(props.contentMode, normalizedSequence);
  const socialHandlesValue = Array.isArray(props.socialHandles)
    ? props.socialHandles.map((entry: unknown) => (typeof entry === 'string' ? entry.trim() : '')).filter((entry: string) => entry.length > 0)
    : ['@modoitaliano.oficial', '@fifth.bell', '@hnmages'];

  const applyProps = (nextProps: any) => {
    replaceProps(componentType, nextProps);
  };

  const activateSequence = async (nextSequence: ToniChyronSequence) => {
    const nextProps = {
      ...props,
      contentMode: 'sequence',
      sequence: nextSequence
    };
    replaceProps(componentType, nextProps);
    if (commitProps) {
      await commitProps(componentType, nextProps);
    }
  };

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap gap-2'>
        <Button
          type='button'
          onClick={() =>
            applyProps({
              ...props,
              contentMode: 'text'
            })
          }
          className={`px-3 py-1.5 rounded text-sm font-medium border ${
            contentMode === 'text' ? 'bg-sea text-white border-sea' : 'bg-dark-sand/80 text-text-primary border-sand/40 hover:bg-dark-sand/60'
          }`}
        >
          Direct Text
        </Button>
        <Button
          type='button'
          onClick={() =>
            applyProps({
              ...props,
              contentMode: 'sequence',
              sequence: normalizedSequence ?? createToniChyronSequence('manual')
            })
          }
          className={`px-3 py-1.5 rounded text-sm font-medium border ${
            contentMode === 'sequence' ? 'bg-sea text-white border-sea' : 'bg-dark-sand/80 text-text-primary border-sand/40 hover:bg-dark-sand/60'
          }`}
        >
          Sequence
        </Button>
      </div>

      {contentMode === 'sequence' ? (
        <div className='space-y-3'>
          <p className='text-xs text-text-secondary'>Sequence mode lets you preload multiple chyron values and take them live with one tap.</p>
          <ToniChyronSequenceEditor
            sequence={normalizedSequence ?? createToniChyronSequence('manual')}
            onChange={(nextSequence) =>
              applyProps({
                ...props,
                contentMode: 'sequence',
                sequence: nextSequence
              })
            }
            onTakeSelection={activateSequence}
          />
          <details className='rounded border border-dashed border-sand/40 px-3 py-2'>
            <summary className='cursor-pointer text-xs font-medium text-text-secondary'>Fallback direct text</summary>
            <div className='space-y-2 pt-3'>
              <div>
                <label className='block text-xs text-text-secondary mb-1'>Fallback Text</label>
                <Input
                  type='text'
                  value={props.text || ''}
                  onChange={(e) => updateProp(componentType, 'text', e.target.value)}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                  placeholder='Used only if the sequence is empty'
                />
              </div>
              <label className='flex items-center gap-2 text-sm text-text-primary'>
                <Input
                  type='checkbox'
                  checked={Boolean(props.useMarquee)}
                  onChange={(e) => updateProp(componentType, 'useMarquee', e.target.checked)}
                  className='h-4 w-4'
                />
                Fallback marquee
              </label>
            </div>
          </details>
        </div>
      ) : (
        <div className='space-y-2'>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Text</label>
            <Input
              type='text'
              value={props.text || ''}
              onChange={(e) => updateProp(componentType, 'text', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='Chyron message'
            />
          </div>
          <label className='flex items-center gap-2 text-sm text-text-primary'>
            <Input
              type='checkbox'
              checked={Boolean(props.useMarquee)}
              onChange={(e) => updateProp(componentType, 'useMarquee', e.target.checked)}
              className='h-4 w-4'
            />
            Force marquee scrolling
          </label>
        </div>
      )}

      <div className='space-y-1'>
        <label className='block text-xs text-text-secondary'>Social Handles (comma-separated)</label>
        <Input
          type='text'
          value={socialHandlesValue.join(', ')}
          onChange={(e) =>
            updateProp(
              componentType,
              'socialHandles',
              e.target.value
                .split(',')
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0)
            )
          }
          className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
          placeholder='@modoitaliano.oficial, @fifth.bell, @hnmages'
        />
        <p className='text-xs text-text-secondary'>Set an empty value to hide social handles.</p>
      </div>
    </div>
  );
}

function ToniChyronSequenceEditor({
  sequence,
  onChange,
  onTakeSelection,
  depth = 0
}: {
  sequence: ToniChyronSequence;
  onChange: (nextSequence: ToniChyronSequence) => void;
  onTakeSelection?: (nextSequence: ToniChyronSequence) => Promise<void> | void;
  depth?: number;
}) {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const isNested = depth > 0;
  const effectiveActiveItemId = getToniChyronSequenceSelectedItemId(sequence, nowMs);

  useEffect(() => {
    if (sequence.mode !== 'autoplay') {
      return;
    }

    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 250);

    return () => clearInterval(timer);
  }, [sequence.mode, sequence.startedAt, sequence.intervalMs, sequence.loop, sequence.items.length]);

  const applySequence = (nextSequence: ToniChyronSequence) => {
    onChange({
      ...nextSequence,
      activeItemId:
        nextSequence.activeItemId && nextSequence.items.some((item) => item.id === nextSequence.activeItemId)
          ? nextSequence.activeItemId
          : (nextSequence.items[0]?.id ?? null)
    });
  };

  const updateItem = (index: number, nextItem: ToniChyronSequenceItem) => {
    const nextItems = sequence.items.map((item, itemIndex) => (itemIndex === index ? nextItem : item));
    applySequence({
      ...sequence,
      items: nextItems
    });
  };

  const toSequenceItem = (item: ToniChyronSequenceItem): Extract<ToniChyronSequenceItem, { kind: 'sequence' }> => {
    if (item.kind === 'sequence') {
      return item;
    }

    const nextItem = createToniChyronSequenceItem('sequence');
    if (nextItem.kind !== 'sequence') {
      return {
        id: item.id,
        label: item.text.trim() || 'Sequence',
        kind: 'sequence',
        sequence: createToniChyronSequence('manual')
      };
    }

    const nestedFirstItem = nextItem.sequence.items[0];
    const nextLeaf =
      nestedFirstItem && nestedFirstItem.kind === 'preset'
        ? {
            ...nestedFirstItem,
            text: item.text,
            useMarquee: item.useMarquee,
            earoneSongId: item.earoneSongId,
            earoneRank: item.earoneRank,
            earoneSpins: item.earoneSpins
          }
        : createToniChyronSequenceItem('preset');

    return {
      ...nextItem,
      id: item.id,
      label: item.text.trim() || 'Sequence',
      sequence: {
        ...nextItem.sequence,
        items: [nextLeaf],
        activeItemId: nextLeaf.id
      }
    };
  };

  const addItem = () => {
    const nextItem = createToniChyronSequenceItem('sequence');
    if (nextItem.kind !== 'sequence') {
      return;
    }

    applySequence({
      ...sequence,
      items: [...sequence.items, nextItem],
      activeItemId: sequence.activeItemId ?? nextItem.id,
      startedAt: Date.now()
    });
  };

  const removeItem = (index: number) => {
    const removedItem = sequence.items[index];
    if (!removedItem) {
      return;
    }

    const nextItems = sequence.items.filter((_, itemIndex) => itemIndex !== index);
    applySequence({
      ...sequence,
      items: nextItems,
      activeItemId: sequence.activeItemId === removedItem.id ? (nextItems[0]?.id ?? null) : sequence.activeItemId,
      startedAt: Date.now()
    });
  };

  const activateItem = async (itemId: string) => {
    const nextSequence = {
      ...sequence,
      activeItemId: itemId,
      startedAt: Date.now()
    };
    applySequence(nextSequence);
    if (onTakeSelection) {
      await onTakeSelection(nextSequence);
    }
  };

  const applySequenceAndTakeSelection = async (nextSequence: ProgramTextSequence) => {
    applySequence(nextSequence);
    if (onTakeSelection) {
      await onTakeSelection(nextSequence);
    }
  };

  const reorderItems = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= sequence.items.length || toIndex >= sequence.items.length) {
      return;
    }

    const nextItems = [...sequence.items];
    const [moved] = nextItems.splice(fromIndex, 1);
    nextItems.splice(toIndex, 0, moved);

    applySequence({
      ...sequence,
      items: nextItems
    });
  };

  return (
    <div className={`space-y-3 rounded border ${isNested ? 'border-sand/30 bg-dark-sand/70' : 'border-sand/40 bg-dark-sand/60'} p-3`}>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='text-xs font-semibold uppercase tracking-wide text-text-secondary'>{isNested ? 'Nested Sequence' : 'Sequence'}</span>
        <Button
          type='button'
          onClick={() => {
            void applySequenceAndTakeSelection({
              ...sequence,
              mode: 'manual',
              activeItemId: sequence.mode === 'autoplay' ? (effectiveActiveItemId ?? sequence.activeItemId) : sequence.activeItemId,
              startedAt: Date.now()
            });
          }}
          className={`px-2.5 py-1 rounded text-xs font-medium border ${
            sequence.mode === 'manual' ? 'bg-sea text-white border-sea' : 'bg-dark-sand/80 text-text-primary border-sand/40 hover:bg-sand/10'
          }`}
        >
          Manual
        </Button>
        <Button
          type='button'
          onClick={() => {
            void applySequenceAndTakeSelection({
              ...sequence,
              mode: 'autoplay',
              startedAt: Date.now()
            });
          }}
          className={`px-2.5 py-1 rounded text-xs font-medium border ${
            sequence.mode === 'autoplay' ? 'bg-sea text-white border-sea' : 'bg-dark-sand/80 text-text-primary border-sand/40 hover:bg-sand/10'
          }`}
        >
          Autoplay
        </Button>
        {sequence.mode === 'autoplay' && (
          <>
            <label className='text-xs text-text-secondary'>Interval (ms)</label>
            <Input
              type='number'
              min={500}
              step={500}
              value={sequence.intervalMs ?? 4000}
              onChange={(e) => {
                void applySequenceAndTakeSelection({
                  ...sequence,
                  intervalMs: Math.max(500, Number(e.target.value) || 4000),
                  startedAt: Date.now()
                });
              }}
              className='w-28 px-2 py-1 text-xs border rounded focus:ring-2 focus:ring-sea/50'
            />
            <label className='flex items-center gap-1 text-xs text-text-secondary'>
              <Input
                type='checkbox'
                checked={sequence.loop !== false}
                onChange={(e) => {
                  void applySequenceAndTakeSelection({
                    ...sequence,
                    loop: e.target.checked
                  });
                }}
                className='h-3.5 w-3.5'
              />
              Loop
            </label>
          </>
        )}
      </div>

      {sequence.items.length === 0 && <p className='text-xs text-text-secondary'>This sequence is empty. Add items below.</p>}

      <div className='space-y-3'>
        {sequence.items.map((item, index) => {
          const displayItem = depth === 0 && item.kind === 'preset' ? toSequenceItem(item) : item;
          const isActive = displayItem.id === effectiveActiveItemId;
          return (
            <div
              key={displayItem.id}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (draggingIndex !== null) {
                  reorderItems(draggingIndex, index);
                }
                setDraggingIndex(null);
              }}
              className={`rounded border p-3 ${isActive ? 'border-sea/40 bg-sea/10' : 'border-sand/30 bg-dark-sand/80'}`}
            >
              <div className='flex flex-wrap items-center gap-2'>
                <span
                  draggable
                  onDragStart={() => setDraggingIndex(index)}
                  onDragEnd={() => setDraggingIndex(null)}
                  className='cursor-grab select-none rounded border border-dashed border-sand/40 p-2 text-text-secondary'
                  title='Drag to reorder'
                  aria-label='Drag to reorder'
                >
                  <GripVertical size={14} strokeWidth={2} />
                </span>
                <div className='min-w-0 flex-1 text-xs font-medium uppercase tracking-wide text-text-secondary'>
                  {displayItem.kind === 'sequence' ? 'Nested Sequence' : 'Sequence Item'}
                </div>
                <Button
                  type='button'
                  onClick={() => {
                    void activateItem(displayItem.id);
                  }}
                  className='px-3 py-2 text-xs font-semibold rounded bg-sea text-white hover:bg-sea/90'
                >
                  Take
                </Button>
                <Button
                  type='button'
                  onClick={() => removeItem(index)}
                  className='px-3 py-2 text-xs font-semibold rounded border border-terracotta/35 text-terracotta hover:bg-terracotta/10'
                >
                  Remove
                </Button>
              </div>

              {displayItem.kind === 'preset' ? (
                <div className='mt-3 space-y-2'>
                  <div>
                    <label className='block text-xs text-text-secondary mb-1'>Text</label>
                    <Input
                      type='text'
                      value={displayItem.text}
                      onChange={(e) =>
                        updateItem(index, {
                          ...displayItem,
                          text: e.target.value
                        })
                      }
                      className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                      placeholder='Chyron message'
                    />
                  </div>
                  <div className='grid grid-cols-2 gap-3'>
                    <div className='col-span-2'>
                      <label className='block text-xs text-text-secondary mb-1'>EarOne Song ID</label>
                      <Input
                        type='text'
                        value={displayItem.earoneSongId || ''}
                        onChange={(e) =>
                          updateItem(index, {
                            ...displayItem,
                            earoneSongId: e.target.value
                          })
                        }
                        className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                        placeholder='Matches against song.earoneSongId'
                      />
                    </div>
                    <div>
                      <label className='block text-xs text-text-secondary mb-1'>Earone Rank</label>
                      <Input
                        type='text'
                        value={displayItem.earoneRank || ''}
                        onChange={(e) =>
                          updateItem(index, {
                            ...displayItem,
                            earoneRank: e.target.value
                          })
                        }
                        className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                        placeholder='e.g. 4'
                      />
                    </div>
                    <div>
                      <label className='block text-xs text-text-secondary mb-1'>Earone Spins</label>
                      <Input
                        type='text'
                        value={displayItem.earoneSpins || ''}
                        onChange={(e) =>
                          updateItem(index, {
                            ...displayItem,
                            earoneSpins: e.target.value
                          })
                        }
                        className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                        placeholder='e.g. 124'
                      />
                    </div>
                  </div>
                  <label className='flex items-center gap-2 text-sm text-text-primary'>
                    <Input
                      type='checkbox'
                      checked={Boolean(displayItem.useMarquee)}
                      onChange={(e) =>
                        updateItem(index, {
                          ...displayItem,
                          useMarquee: e.target.checked
                        })
                      }
                      className='h-4 w-4'
                    />
                    Force marquee scrolling
                  </label>
                </div>
              ) : (
                <div className='mt-3'>
                  <ToniChyronSequenceEditor
                    sequence={displayItem.sequence}
                    depth={depth + 1}
                    onChange={(nextNestedSequence) =>
                      updateItem(index, {
                        ...displayItem,
                        sequence: nextNestedSequence
                      })
                    }
                    onTakeSelection={async (nextNestedSequence) => {
                      const nextSequence = {
                        ...sequence,
                        items: sequence.items.map((entry, sequenceIndex) =>
                          sequenceIndex === index
                            ? {
                                ...displayItem,
                                sequence: nextNestedSequence
                              }
                            : entry
                        )
                      };
                      applySequence(nextSequence);
                      if (onTakeSelection) {
                        await onTakeSelection(nextSequence);
                      }
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className='flex flex-wrap gap-2'>
        <Button type='button' onClick={addItem} className='px-3 py-2 text-xs font-semibold rounded border border-sand/40 text-text-primary hover:bg-sand/10'>
          + Sequence
        </Button>
      </div>
    </div>
  );
}

function flattenProgramSongItems(items: ProgramSongSequenceItem[]): Extract<ProgramSongSequenceItem, { kind: 'preset' }>[] {
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

function normalizeProgramSongPlaylist(sequence: ProgramSongSequence): ProgramSongSequence {
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

function RelojDigitalEditorFields({
  componentType,
  props,
  updateProp,
  replaceProps,
  commitProps,
  timezoneOptions
}: {
  componentType: string;
  props: any;
  updateProp: (componentType: string, propName: string, value: any) => void;
  replaceProps: (componentType: string, nextProps: any) => void;
  commitProps?: (componentType: string, nextProps: any) => Promise<void> | void;
  timezoneOptions: { value: string; label: string }[];
}) {
  const normalizedTextSequence = normalizeProgramTextSequence(props.textSequence, 0, { includeMarquee: false });
  const normalizedCtaSequence = normalizeProgramTextSequence(props.ctaSequence, 0, { includeMarquee: false });

  const textSequenceForEditor = useMemo<ProgramTextSequence>(() => {
    return normalizedTextSequence ?? createProgramTextSequence('manual', { includeMarquee: false });
  }, [normalizedTextSequence]);

  const ctaSequenceForEditor = useMemo<ProgramTextSequence>(() => {
    return normalizedCtaSequence ?? createProgramTextSequence('manual', { includeMarquee: false });
  }, [normalizedCtaSequence]);

  const buildSequenceProps = (nextTextSequence: ProgramTextSequence, nextCtaSequence: ProgramTextSequence) => ({
    ...props,
    textSequence: nextTextSequence,
    ctaSequence: nextCtaSequence,
    _timestamp: Date.now()
  });

  const activateTextSequence = async (nextSequence: ProgramTextSequence) => {
    const nextProps = buildSequenceProps(nextSequence, ctaSequenceForEditor);
    replaceProps(componentType, nextProps);
    if (commitProps) {
      await commitProps(componentType, nextProps);
    }
  };

  const activateCtaSequence = async (nextSequence: ProgramTextSequence) => {
    const nextProps = buildSequenceProps(textSequenceForEditor, nextSequence);
    replaceProps(componentType, nextProps);
    if (commitProps) {
      await commitProps(componentType, nextProps);
    }
  };

  const applyProps = (nextProps: unknown) => {
    replaceProps(componentType, nextProps);
  };

  return (
    <div className='space-y-4'>
      <div>
        <label className='block text-xs font-semibold uppercase tracking-wide text-text-secondary mb-1'>Starting Timezone</label>
        <Select
          value={props.timezone || 'America/New_York'}
          onChange={(value) => updateProp(componentType, 'timezone', value)}
          className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50 bg-black/20 text-white'
          options={timezoneOptions}
        />
      </div>

      <div className='space-y-2 rounded border border-sand/30 p-3'>
        <span className='text-xs font-semibold uppercase tracking-wide text-text-secondary'>Lower Third Title</span>
        <div className='space-y-3'>
          <p className='text-xs text-text-secondary'>Sequence-only. If no text item is active, the entire lower third strip hides.</p>
          <ProgramTextSequenceEditor
            sequence={textSequenceForEditor}
            textLabel='Title'
            textPlaceholder='Main lower third title'
            onChange={(nextSequence) => applyProps(buildSequenceProps(nextSequence, ctaSequenceForEditor))}
            onTakeSelection={activateTextSequence}
          />
        </div>
      </div>

      <div className='space-y-2 rounded border border-sand/30 p-3'>
        <span className='text-xs font-semibold uppercase tracking-wide text-text-secondary'>CTA Sequence</span>
        <div className='space-y-3'>
          <p className='text-xs text-text-secondary'>CTA sequence rotates automatically if configured as playlist.</p>
          <ProgramTextSequenceEditor
            sequence={ctaSequenceForEditor}
            textLabel='CTA'
            textPlaceholder='e.g. YA VIENE, UP NEXT'
            onChange={(nextSequence) => applyProps(buildSequenceProps(textSequenceForEditor, nextSequence))}
            onTakeSelection={activateCtaSequence}
          />
        </div>
      </div>
    </div>
  );
}

function ProgramChyronEditorFields({
  componentType,
  props,
  updateProp,
  replaceProps,
  commitProps
}: {
  componentType: string;
  props: any;
  updateProp: (componentType: string, propName: string, value: any) => void;
  replaceProps: (componentType: string, nextProps: any) => void;
  commitProps?: (componentType: string, nextProps: any) => Promise<void> | void;
}) {
  const normalizedTextSequence = normalizeProgramTextSequence(props.textSequence, 0, { includeMarquee: true });
  const normalizedCtaSequence = normalizeProgramTextSequence(props.ctaSequence);
  const showValue = typeof props.show === 'boolean' ? props.show : typeof props.show === 'string' ? props.show.trim().toLowerCase() !== 'false' : true;
  const legacyMainText = typeof props.text === 'string' ? props.text : '';
  const legacyUseMarquee = Boolean(props.useMarquee);
  const legacyCtaText = typeof props.cta === 'string' ? props.cta : '';

  const sequenceHasText = (sequence: ProgramTextSequence): boolean =>
    sequence.items.some((item) => (item.kind === 'sequence' ? sequenceHasText(item.sequence) : Boolean(item.text.trim())));

  const textSequenceForEditor = useMemo<ProgramTextSequence>(() => {
    const baseSequence = normalizedTextSequence ?? createProgramTextSequence('manual', { includeMarquee: true });
    if (!legacyMainText.trim() && !legacyUseMarquee) {
      return baseSequence;
    }
    if (sequenceHasText(baseSequence)) {
      return baseSequence;
    }

    const firstItem = baseSequence.items[0];
    const fallbackItem = createProgramTextSequenceItem('preset', { includeMarquee: true });
    const seededItem =
      firstItem && firstItem.kind === 'preset'
        ? {
            ...firstItem,
            text: legacyMainText,
            useMarquee: legacyUseMarquee
          }
        : {
            ...(fallbackItem.kind === 'preset' ? fallbackItem : createProgramTextSequenceItem('preset', { includeMarquee: true })),
            text: legacyMainText,
            useMarquee: legacyUseMarquee
          };

    const nextItems = [...baseSequence.items];
    nextItems[0] = seededItem;

    return {
      ...baseSequence,
      items: nextItems,
      activeItemId: baseSequence.activeItemId ?? seededItem.id,
      startedAt: baseSequence.startedAt ?? Date.now()
    };
  }, [normalizedTextSequence, legacyMainText, legacyUseMarquee]);

  const ctaSequenceForEditor = useMemo<ProgramTextSequence>(() => {
    const baseSequence = normalizedCtaSequence ?? createProgramTextSequence('manual');
    if (!legacyCtaText.trim()) {
      return baseSequence;
    }
    if (sequenceHasText(baseSequence)) {
      return baseSequence;
    }

    const firstItem = baseSequence.items[0];
    const fallbackItem = createProgramTextSequenceItem('preset');
    const seededItem =
      firstItem && firstItem.kind === 'preset'
        ? {
            ...firstItem,
            text: legacyCtaText
          }
        : {
            ...(fallbackItem.kind === 'preset' ? fallbackItem : createProgramTextSequenceItem('preset')),
            text: legacyCtaText
          };

    const nextItems = [...baseSequence.items];
    nextItems[0] = seededItem;

    return {
      ...baseSequence,
      items: nextItems,
      activeItemId: baseSequence.activeItemId ?? seededItem.id,
      startedAt: baseSequence.startedAt ?? Date.now()
    };
  }, [normalizedCtaSequence, legacyCtaText]);

  const buildSequenceProps = (nextTextSequence: ProgramTextSequence, nextCtaSequence: ProgramTextSequence) => ({
    ...props,
    textSequence: nextTextSequence,
    ctaSequence: nextCtaSequence,
    text: '',
    useMarquee: false,
    cta: ''
  });

  const applyProps = (nextProps: any) => {
    replaceProps(componentType, nextProps);
  };

  const activateTextSequence = async (nextSequence: ProgramTextSequence) => {
    const nextProps = buildSequenceProps(nextSequence, ctaSequenceForEditor);
    replaceProps(componentType, nextProps);
    if (commitProps) {
      await commitProps(componentType, nextProps);
    }
  };

  const activateCtaSequence = async (nextSequence: ProgramTextSequence) => {
    const nextProps = buildSequenceProps(textSequenceForEditor, nextSequence);
    replaceProps(componentType, nextProps);
    if (commitProps) {
      await commitProps(componentType, nextProps);
    }
  };

  return (
    <div className='space-y-4'>
      <p className='text-xs text-text-secondary'>ModoItaliano row rule: if chyron and disclaimer are both enabled, chyron is shown.</p>
      <Switch checked={showValue} onCheckedChange={(checked) => updateProp(componentType, 'show', checked)} label='Show Chyron' />

      {showValue ? (
        <>
          <div className='space-y-2 rounded border border-sand/30 p-3'>
            <span className='text-xs font-semibold uppercase tracking-wide text-text-secondary'>Main Chyron</span>
            <div className='space-y-3'>
              <p className='text-xs text-text-secondary'>Sequence-only. If no text item is selected, the chyron is hidden.</p>
              <ProgramTextSequenceEditor
                sequence={textSequenceForEditor}
                includeMarquee
                textLabel='Text'
                textPlaceholder='Main chyron text'
                onChange={(nextSequence) => applyProps(buildSequenceProps(nextSequence, ctaSequenceForEditor))}
                onTakeSelection={activateTextSequence}
              />
            </div>
          </div>

          <div className='space-y-2 rounded border border-sand/30 p-3'>
            <span className='text-xs font-semibold uppercase tracking-wide text-text-secondary'>CTA</span>
            <div className='space-y-3'>
              <p className='text-xs text-text-secondary'>CTA is sequence-only as well.</p>
              <ProgramTextSequenceEditor
                sequence={ctaSequenceForEditor}
                textLabel='CTA'
                textPlaceholder='Call to action (shown above chyron)'
                onChange={(nextSequence) => applyProps(buildSequenceProps(textSequenceForEditor, nextSequence))}
                onTakeSelection={activateCtaSequence}
              />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ProgramTextSequenceEditor({
  sequence,
  onChange,
  onTakeSelection,
  depth = 0,
  includeMarquee = false,
  textLabel = 'Text',
  textPlaceholder = 'Text'
}: {
  sequence: ProgramTextSequence;
  onChange: (nextSequence: ProgramTextSequence) => void;
  onTakeSelection?: (nextSequence: ProgramTextSequence) => Promise<void> | void;
  depth?: number;
  includeMarquee?: boolean;
  textLabel?: string;
  textPlaceholder?: string;
}) {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const isNested = depth > 0;
  const effectiveActiveItemId = getProgramTextSequenceSelectedItemId(sequence, nowMs);

  useEffect(() => {
    if (sequence.mode !== 'autoplay') {
      return;
    }

    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 250);

    return () => clearInterval(timer);
  }, [sequence.mode, sequence.startedAt, sequence.intervalMs, sequence.loop, sequence.items.length]);

  const applySequence = (nextSequence: ProgramTextSequence) => {
    onChange({
      ...nextSequence,
      activeItemId:
        nextSequence.activeItemId && nextSequence.items.some((item) => item.id === nextSequence.activeItemId)
          ? nextSequence.activeItemId
          : (nextSequence.items[0]?.id ?? null)
    });
  };

  const updateItem = (index: number, nextItem: ProgramTextSequenceItem) => {
    const nextItems = sequence.items.map((item, itemIndex) => (itemIndex === index ? nextItem : item));
    applySequence({
      ...sequence,
      items: nextItems
    });
  };

  const toSequenceItem = (item: ProgramTextSequenceItem): Extract<ProgramTextSequenceItem, { kind: 'sequence' }> => {
    if (item.kind === 'sequence') {
      return item;
    }

    const nextItem = createProgramTextSequenceItem('sequence', { includeMarquee });
    if (nextItem.kind !== 'sequence') {
      return {
        id: item.id,
        label: item.text.trim() || 'Sequence',
        kind: 'sequence',
        sequence: createProgramTextSequence('manual', { includeMarquee })
      };
    }

    const nestedFirstItem = nextItem.sequence.items[0];
    const nextLeaf =
      nestedFirstItem && nestedFirstItem.kind === 'preset'
        ? {
            ...nestedFirstItem,
            text: item.text,
            useMarquee: includeMarquee ? item.useMarquee : undefined
          }
        : createProgramTextSequenceItem('preset', { includeMarquee });

    return {
      ...nextItem,
      id: item.id,
      label: item.text.trim() || 'Sequence',
      sequence: {
        ...nextItem.sequence,
        items: [nextLeaf],
        activeItemId: nextLeaf.id
      }
    };
  };

  const addItem = () => {
    const nextItem = createProgramTextSequenceItem('sequence', { includeMarquee });
    if (nextItem.kind !== 'sequence') {
      return;
    }

    applySequence({
      ...sequence,
      items: [...sequence.items, nextItem],
      activeItemId: sequence.activeItemId ?? nextItem.id,
      startedAt: Date.now()
    });
  };

  const removeItem = (index: number) => {
    const removedItem = sequence.items[index];
    if (!removedItem) {
      return;
    }

    const nextItems = sequence.items.filter((_, itemIndex) => itemIndex !== index);
    applySequence({
      ...sequence,
      items: nextItems,
      activeItemId: sequence.activeItemId === removedItem.id ? (nextItems[0]?.id ?? null) : sequence.activeItemId,
      startedAt: Date.now()
    });
  };

  const activateItem = async (itemId: string) => {
    const nextSequence = {
      ...sequence,
      activeItemId: itemId,
      startedAt: Date.now()
    };
    applySequence(nextSequence);
    if (onTakeSelection) {
      await onTakeSelection(nextSequence);
    }
  };

  const reorderItems = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= sequence.items.length || toIndex >= sequence.items.length) {
      return;
    }

    const nextItems = [...sequence.items];
    const [moved] = nextItems.splice(fromIndex, 1);
    nextItems.splice(toIndex, 0, moved);

    applySequence({
      ...sequence,
      items: nextItems
    });
  };

  return (
    <div className={`space-y-3 rounded border ${isNested ? 'border-sand/30 bg-dark-sand/70' : 'border-sand/40 bg-dark-sand/60'} p-3`}>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='text-xs font-semibold uppercase tracking-wide text-text-secondary'>{isNested ? 'Nested Sequence' : 'Sequence'}</span>
        <Button
          type='button'
          onClick={() =>
            applySequence({
              ...sequence,
              mode: 'manual',
              activeItemId: sequence.mode === 'autoplay' ? (effectiveActiveItemId ?? sequence.activeItemId) : sequence.activeItemId,
              startedAt: Date.now()
            })
          }
          className={`px-2.5 py-1 rounded text-xs font-medium border ${
            sequence.mode === 'manual' ? 'bg-sea text-white border-sea' : 'bg-dark-sand/80 text-text-primary border-sand/40 hover:bg-sand/10'
          }`}
        >
          Manual
        </Button>
        <Button
          type='button'
          onClick={() =>
            applySequence({
              ...sequence,
              mode: 'autoplay',
              startedAt: Date.now()
            })
          }
          className={`px-2.5 py-1 rounded text-xs font-medium border ${
            sequence.mode === 'autoplay' ? 'bg-sea text-white border-sea' : 'bg-dark-sand/80 text-text-primary border-sand/40 hover:bg-sand/10'
          }`}
        >
          Autoplay
        </Button>
        {sequence.mode === 'autoplay' && (
          <>
            <label className='text-xs text-text-secondary'>Interval (ms)</label>
            <Input
              type='number'
              min={500}
              step={500}
              value={sequence.intervalMs ?? 4000}
              onChange={(e) =>
                applySequence({
                  ...sequence,
                  intervalMs: Math.max(500, Number(e.target.value) || 4000),
                  startedAt: Date.now()
                })
              }
              className='w-28 px-2 py-1 text-xs border rounded focus:ring-2 focus:ring-sea/50'
            />
            <label className='flex items-center gap-1 text-xs text-text-secondary'>
              <Input
                type='checkbox'
                checked={sequence.loop !== false}
                onChange={(e) =>
                  applySequence({
                    ...sequence,
                    loop: e.target.checked
                  })
                }
                className='h-3.5 w-3.5'
              />
              Loop
            </label>
          </>
        )}
      </div>

      {sequence.items.length === 0 && <p className='text-xs text-text-secondary'>This sequence is empty. Add items below.</p>}

      <div className='space-y-3'>
        {sequence.items.map((item, index) => {
          const displayItem = depth === 0 && item.kind === 'preset' ? toSequenceItem(item) : item;
          const isActive = displayItem.id === effectiveActiveItemId;
          return (
            <div
              key={displayItem.id}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (draggingIndex !== null) {
                  reorderItems(draggingIndex, index);
                }
                setDraggingIndex(null);
              }}
              className={`rounded border p-3 ${isActive ? 'border-sea/40 bg-sea/10' : 'border-sand/30 bg-dark-sand/80'}`}
            >
              <div className='flex flex-wrap items-center gap-2'>
                <span
                  draggable
                  onDragStart={() => setDraggingIndex(index)}
                  onDragEnd={() => setDraggingIndex(null)}
                  className='cursor-grab select-none rounded border border-dashed border-sand/40 p-2 text-text-secondary'
                  title='Drag to reorder'
                  aria-label='Drag to reorder'
                >
                  <GripVertical size={14} strokeWidth={2} />
                </span>
                <div className='min-w-0 flex-1 text-xs font-medium uppercase tracking-wide text-text-secondary'>
                  {displayItem.kind === 'sequence' ? 'Nested Sequence' : 'Sequence Item'}
                </div>
                <Button
                  type='button'
                  onClick={() => {
                    void activateItem(displayItem.id);
                  }}
                  className='px-3 py-2 text-xs font-semibold rounded bg-sea text-white hover:bg-sea/90'
                >
                  Take
                </Button>
                <Button
                  type='button'
                  onClick={() => removeItem(index)}
                  className='px-3 py-2 text-xs font-semibold rounded border border-terracotta/35 text-terracotta hover:bg-terracotta/10'
                >
                  Remove
                </Button>
              </div>

              {displayItem.kind === 'preset' ? (
                <div className='mt-3 space-y-2'>
                  <label className='text-sm text-text-primary block'>
                    <span className='block text-xs text-text-secondary mb-1'>{textLabel}</span>
                    <Input
                      type='text'
                      value={displayItem.text}
                      onChange={(e) =>
                        updateItem(index, {
                          ...displayItem,
                          text: e.target.value
                        })
                      }
                      className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                      placeholder={textPlaceholder}
                    />
                  </label>
                  {includeMarquee && (
                    <label className='flex items-center gap-2 text-sm text-text-primary'>
                      <Input
                        type='checkbox'
                        checked={Boolean(displayItem.useMarquee)}
                        onChange={(e) =>
                          updateItem(index, {
                            ...displayItem,
                            useMarquee: e.target.checked
                          })
                        }
                        className='h-4 w-4'
                      />
                      Force marquee scrolling
                    </label>
                  )}
                </div>
              ) : (
                <div className='mt-3'>
                  <ProgramTextSequenceEditor
                    sequence={displayItem.sequence}
                    depth={depth + 1}
                    includeMarquee={includeMarquee}
                    textLabel={textLabel}
                    textPlaceholder={textPlaceholder}
                    onChange={(nextNestedSequence) =>
                      updateItem(index, {
                        ...displayItem,
                        sequence: nextNestedSequence
                      })
                    }
                    onTakeSelection={async (nextNestedSequence) => {
                      const nextSequence = {
                        ...sequence,
                        items: sequence.items.map((entry, sequenceIndex) =>
                          sequenceIndex === index
                            ? {
                                ...displayItem,
                                sequence: nextNestedSequence
                              }
                            : entry
                        )
                      };
                      applySequence(nextSequence);
                      if (onTakeSelection) {
                        await onTakeSelection(nextSequence);
                      }
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className='flex flex-wrap gap-2'>
        <Button type='button' onClick={addItem} className='px-3 py-2 text-xs font-semibold rounded border border-sand/40 text-text-primary hover:bg-sand/10'>
          + Sequence
        </Button>
      </div>
    </div>
  );
}

function ProgramSongSequenceEditor({
  sequence,
  songCatalog = [],
  programSongPlayback = null,
  onChange,
  onTakeSelection,
  onTakeOffAir,
  onStopAllInstants,
  sceneQuickActions = [],
  onStageScene,
  onTakeScene,
  depth = 0,
  view = 'full',
  showPlaybackBar = true
}: {
  sequence: ProgramSongSequence;
  songCatalog?: SongCatalogItem[];
  programSongPlayback?: ProgramSongPlaybackState | null;
  onChange: (nextSequence: ProgramSongSequence) => void;
  onTakeSelection?: (nextSequence: ProgramSongSequence) => Promise<void> | void;
  onTakeOffAir?: () => Promise<void> | void;
  onStopAllInstants?: () => void;
  sceneQuickActions?: Array<{
    id: number;
    name: string;
    isActive: boolean;
    isStaged: boolean;
    shortcutLabel: string;
  }>;
  onStageScene?: (sceneId: number) => void;
  onTakeScene?: (sceneId: number) => void;
  depth?: number;
  view?: 'full' | 'catalog' | 'queue';
  showPlaybackBar?: boolean;
}) {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const [addSongValue, setAddSongValue] = useState('');
  const [stickyPlaybackItemId, setStickyPlaybackItemId] = useState<string | null>(null);
  const songDurationByUrlRef = useRef<Record<string, number | null>>({});
  const autoTakeOffTimerRef = useRef<number | null>(null);
  const sequenceRef = useRef(sequence);
  const isNested = depth > 0;
  const showQueue = view !== 'catalog';
  const showCatalog = view !== 'queue';
  const showQueueHeading = view === 'full';
  const hasFixedPlaybackBar = showPlaybackBar && !isNested;
  const showSceneQuickBar = hasFixedPlaybackBar && sceneQuickActions.length > 0;
  const effectiveActiveItemId = getProgramSongSequenceSelectedItemId(sequence, nowMs);
  const playbackActiveItemId = useMemo(() => {
    if (!programSongPlayback?.isPlaying) {
      return null;
    }

    const playbackToken = (programSongPlayback.token || '').trim();
    const playbackAudioUrl = (programSongPlayback.audioUrl || '').trim();

    if (playbackToken) {
      const tokenMatch = sequence.items.find((item) => item.id && playbackToken.startsWith(`${item.id}:`));
      if (tokenMatch) {
        return tokenMatch.id;
      }
    }

    if (playbackAudioUrl) {
      const urlMatches = sequence.items.filter((item) => item.kind === 'preset' && (item.audioUrl || '').trim() === playbackAudioUrl);
      if (urlMatches.length === 1) {
        return urlMatches[0]?.id ?? null;
      }
      if (urlMatches.length > 1) {
        if (sequence.activeItemId && urlMatches.some((item) => item.id === sequence.activeItemId)) {
          return sequence.activeItemId;
        }
        if (effectiveActiveItemId && urlMatches.some((item) => item.id === effectiveActiveItemId)) {
          return effectiveActiveItemId;
        }
      }
    }

    return null;
  }, [effectiveActiveItemId, programSongPlayback?.audioUrl, programSongPlayback?.isPlaying, programSongPlayback?.token, sequence.activeItemId, sequence.items]);

  useEffect(() => {
    if (programSongPlayback?.isPlaying) {
      if (playbackActiveItemId && sequence.items.some((item) => item.id === playbackActiveItemId)) {
        if (stickyPlaybackItemId !== playbackActiveItemId) {
          setStickyPlaybackItemId(playbackActiveItemId);
        }
        return;
      }

      if (stickyPlaybackItemId && !sequence.items.some((item) => item.id === stickyPlaybackItemId)) {
        setStickyPlaybackItemId(null);
      }
      return;
    }

    if (stickyPlaybackItemId !== null) {
      setStickyPlaybackItemId(null);
    }
  }, [playbackActiveItemId, programSongPlayback?.isPlaying, sequence.items, stickyPlaybackItemId]);

  const runtimeActiveItemId = useMemo(() => {
    if (programSongPlayback?.isPlaying) {
      return stickyPlaybackItemId ?? playbackActiveItemId ?? sequence.activeItemId ?? (sequence.mode === 'autoplay' ? effectiveActiveItemId : null) ?? null;
    }
    return sequence.mode === 'autoplay' ? (effectiveActiveItemId ?? sequence.activeItemId ?? null) : (sequence.activeItemId ?? null);
  }, [effectiveActiveItemId, playbackActiveItemId, programSongPlayback?.isPlaying, sequence.activeItemId, sequence.mode, stickyPlaybackItemId]);
  const runtimeActiveItemIndex = runtimeActiveItemId ? sequence.items.findIndex((item) => item.id === runtimeActiveItemId) : -1;
  const availableSongCatalog = useMemo(
    () =>
      songCatalog
        .filter((song) => song.enabled && typeof song.audioUrl === 'string' && song.audioUrl.trim().length > 0)
        .sort((a, b) => {
          const aTitle = [a.artist, a.title].filter(Boolean).join(' - ').toLowerCase();
          const bTitle = [b.artist, b.title].filter(Boolean).join(' - ').toLowerCase();
          return aTitle.localeCompare(bTitle);
        }),
    [songCatalog]
  );
  const catalogOptions = useMemo(
    () =>
      availableSongCatalog.map((song) => ({
        value: String(song.id),
        label: [song.artist, song.title].filter(Boolean).join(' - ') || `Song #${song.id}`
      })),
    [availableSongCatalog]
  );

  useEffect(() => {
    sequenceRef.current = sequence;
  }, [sequence]);

  useEffect(() => {
    if (!expandedItemId) {
      return;
    }
    if (!sequence.items.some((item) => item.id === expandedItemId)) {
      setExpandedItemId(null);
    }
  }, [sequence.items, expandedItemId]);

  useEffect(() => {
    if (!sequence.activeItemId && !programSongPlayback?.isPlaying) {
      return;
    }

    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 250);

    return () => clearInterval(timer);
  }, [programSongPlayback?.isPlaying, sequence.activeItemId, sequence.startedAt]);

  const applySequence = (nextSequence: ProgramSongSequence) => {
    onChange({
      ...nextSequence,
      activeItemId:
        nextSequence.activeItemId === null
          ? null
          : nextSequence.activeItemId && nextSequence.items.some((item) => item.id === nextSequence.activeItemId)
            ? nextSequence.activeItemId
            : (nextSequence.items[0]?.id ?? null)
    });
  };

  const clearAutoTakeOffTimer = () => {
    if (autoTakeOffTimerRef.current !== null) {
      window.clearTimeout(autoTakeOffTimerRef.current);
      autoTakeOffTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      clearAutoTakeOffTimer();
    };
  }, []);

  useEffect(() => {
    if (sequence.mode !== 'manual' || sequence.activeItemId === null) {
      clearAutoTakeOffTimer();
    }
  }, [sequence.mode, sequence.activeItemId]);

  const updateItem = (index: number, nextItem: ProgramSongSequenceItem) => {
    const nextItems = sequence.items.map((item, itemIndex) => (itemIndex === index ? nextItem : item));
    applySequence({
      ...sequence,
      items: nextItems
    });
  };

  const addItem = () => {
    const nextItem = createProgramSongSequenceItem('preset');
    if (nextItem.kind !== 'preset') {
      return;
    }

    const isAutoplay = sequence.mode === 'autoplay';
    const anchorActiveItemId = isAutoplay ? (runtimeActiveItemId ?? sequence.activeItemId ?? nextItem.id) : (runtimeActiveItemId ?? nextItem.id);

    applySequence({
      ...sequence,
      items: [...sequence.items, nextItem],
      activeItemId: anchorActiveItemId,
      startedAt: isAutoplay ? resolveAutoplayStartedAt() : Date.now()
    });
  };

  const addItemFromCatalog = (songId: number) => {
    const selectedSong = availableSongCatalog.find((s) => s.id === songId);
    if (!selectedSong) return;
    const nextItem = createProgramSongSequenceItem('preset');
    if (nextItem.kind !== 'preset') return;
    const filledItem = {
      ...nextItem,
      artist: selectedSong.artist || '',
      title: selectedSong.title || '',
      coverUrl: selectedSong.coverUrl || '',
      audioUrl: selectedSong.audioUrl || '',
      durationMs:
        typeof selectedSong.durationMs === 'number' && Number.isFinite(selectedSong.durationMs) && selectedSong.durationMs > 0
          ? Math.round(selectedSong.durationMs)
          : nextItem.durationMs,
      earoneSongId: selectedSong.earoneSongId || nextItem.earoneSongId,
      earoneRank: selectedSong.earoneRank || nextItem.earoneRank,
      earoneSpins: selectedSong.earoneSpins || nextItem.earoneSpins
    };
    applySequence({
      ...sequence,
      items: [...sequence.items, filledItem],
      activeItemId: sequence.mode === 'autoplay' ? (runtimeActiveItemId ?? sequence.activeItemId ?? filledItem.id) : runtimeActiveItemId
    });
  };

  const removeItem = (index: number) => {
    const removedItem = sequence.items[index];
    if (!removedItem) {
      return;
    }

    const nextItems = sequence.items.filter((_, itemIndex) => itemIndex !== index);
    const isAutoplay = sequence.mode === 'autoplay';
    const currentRuntimeActiveItemId = isAutoplay ? (runtimeActiveItemId ?? sequence.activeItemId) : (runtimeActiveItemId ?? sequence.activeItemId);
    const removedCurrentRuntimeItem = currentRuntimeActiveItemId !== null && currentRuntimeActiveItemId === removedItem.id;
    let nextActiveItemId: string | null;

    if (nextItems.length === 0) {
      nextActiveItemId = null;
    } else if (removedCurrentRuntimeItem) {
      nextActiveItemId = nextItems[Math.min(index, nextItems.length - 1)]?.id ?? null;
    } else {
      nextActiveItemId =
        currentRuntimeActiveItemId && nextItems.some((item) => item.id === currentRuntimeActiveItemId)
          ? currentRuntimeActiveItemId
          : (nextItems[0]?.id ?? null);
    }

    applySequence({
      ...sequence,
      items: nextItems,
      activeItemId: nextActiveItemId,
      startedAt: isAutoplay && !removedCurrentRuntimeItem ? resolveAutoplayStartedAt() : Date.now()
    });
  };

  const scheduleAutoTakeOffForSequence = (nextSequence: ProgramSongSequence) => {
    clearAutoTakeOffTimer();

    if (isNested || nextSequence.mode !== 'manual') {
      return;
    }

    const resolvedLeaf = resolveProgramSongLeaf({ sequence: nextSequence }, Date.now());
    const durationMs = resolvedLeaf?.durationMs;

    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
      const fallbackAudioUrl = resolvedLeaf?.audioUrl?.trim();
      if (!fallbackAudioUrl) {
        return;
      }

      const cachedDuration = songDurationByUrlRef.current[fallbackAudioUrl];
      if (typeof cachedDuration === 'number' && Number.isFinite(cachedDuration) && cachedDuration > 0) {
        const fallbackSequenceWithDuration = {
          ...nextSequence,
          items: nextSequence.items
        };
        const expectedActiveItemId = fallbackSequenceWithDuration.activeItemId ?? null;
        const expectedStartedAt =
          typeof fallbackSequenceWithDuration.startedAt === 'number' && Number.isFinite(fallbackSequenceWithDuration.startedAt)
            ? fallbackSequenceWithDuration.startedAt
            : null;

        autoTakeOffTimerRef.current = window.setTimeout(
          () => {
            const currentSequence = sequenceRef.current;
            const currentStartedAt =
              typeof currentSequence.startedAt === 'number' && Number.isFinite(currentSequence.startedAt) ? currentSequence.startedAt : null;
            if (currentSequence.activeItemId !== expectedActiveItemId) {
              return;
            }
            if (currentStartedAt !== expectedStartedAt) {
              return;
            }
            void clearActiveItem();
          },
          Math.max(200, Math.round(cachedDuration))
        );
        return;
      }

      const audio = new Audio();
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => {
        const seconds = Number(audio.duration);
        audio.onloadedmetadata = null;
        audio.onerror = null;
        audio.src = '';
        const derivedDuration = Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.round(seconds * 1000)) : null;
        songDurationByUrlRef.current[fallbackAudioUrl] = derivedDuration;
        if (!derivedDuration) {
          return;
        }

        const expectedActiveItemId = nextSequence.activeItemId ?? null;
        const expectedStartedAt = typeof nextSequence.startedAt === 'number' && Number.isFinite(nextSequence.startedAt) ? nextSequence.startedAt : null;

        clearAutoTakeOffTimer();
        autoTakeOffTimerRef.current = window.setTimeout(
          () => {
            const currentSequence = sequenceRef.current;
            const currentStartedAt =
              typeof currentSequence.startedAt === 'number' && Number.isFinite(currentSequence.startedAt) ? currentSequence.startedAt : null;
            if (currentSequence.activeItemId !== expectedActiveItemId) {
              return;
            }
            if (currentStartedAt !== expectedStartedAt) {
              return;
            }
            void clearActiveItem();
          },
          Math.max(200, derivedDuration)
        );
      };
      audio.onerror = () => {
        audio.onloadedmetadata = null;
        audio.onerror = null;
        audio.src = '';
        songDurationByUrlRef.current[fallbackAudioUrl] = null;
      };
      audio.src = fallbackAudioUrl;
      audio.load();
      return;
    }

    const expectedActiveItemId = nextSequence.activeItemId ?? null;
    const expectedStartedAt = typeof nextSequence.startedAt === 'number' && Number.isFinite(nextSequence.startedAt) ? nextSequence.startedAt : null;

    autoTakeOffTimerRef.current = window.setTimeout(
      () => {
        const currentSequence = sequenceRef.current;
        const currentStartedAt = typeof currentSequence.startedAt === 'number' && Number.isFinite(currentSequence.startedAt) ? currentSequence.startedAt : null;

        if (currentSequence.activeItemId !== expectedActiveItemId) {
          return;
        }
        if (currentStartedAt !== expectedStartedAt) {
          return;
        }

        void clearActiveItem();
      },
      Math.max(200, Math.round(durationMs))
    );
  };

  const activateItem = async (itemId: string) => {
    clearAutoTakeOffTimer();

    const nextSequence = {
      ...sequence,
      activeItemId: itemId,
      startedAt: Date.now()
    };
    applySequence(nextSequence);
    if (onTakeSelection) {
      await onTakeSelection(nextSequence);
    }
    scheduleAutoTakeOffForSequence(nextSequence);
  };

  const clearActiveItem = async () => {
    clearAutoTakeOffTimer();

    const nextSequence = {
      ...sequence,
      mode: 'manual' as const,
      activeItemId: null
    };
    applySequence(nextSequence);
    if (onTakeSelection) {
      await onTakeSelection(nextSequence);
    }
    if (!isNested && onTakeOffAir) {
      await onTakeOffAir();
    }
  };

  const reorderItems = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= sequence.items.length || toIndex >= sequence.items.length) {
      return;
    }

    const nextItems = [...sequence.items];
    const [moved] = nextItems.splice(fromIndex, 1);
    nextItems.splice(toIndex, 0, moved);

    applySequence({
      ...sequence,
      items: nextItems
    });
  };

  const applyCatalogSongToItem = (index: number, item: Extract<ProgramSongSequenceItem, { kind: 'preset' }>, selectedSong: SongCatalogItem) => {
    updateItem(index, {
      ...item,
      artist: selectedSong.artist || item.artist,
      title: selectedSong.title || item.title,
      coverUrl: selectedSong.coverUrl || item.coverUrl,
      audioUrl: selectedSong.audioUrl || item.audioUrl,
      durationMs:
        typeof selectedSong.durationMs === 'number' && Number.isFinite(selectedSong.durationMs) && selectedSong.durationMs > 0
          ? Math.round(selectedSong.durationMs)
          : item.durationMs,
      earoneSongId: selectedSong.earoneSongId || item.earoneSongId,
      earoneRank: selectedSong.earoneRank || item.earoneRank,
      earoneSpins: selectedSong.earoneSpins || item.earoneSpins
    });
  };

  const formatDurationFromMs = (value: number | undefined): string => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return 'Unknown';
    }

    const totalSeconds = Math.max(1, Math.round(value / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  };

  const resolveAutoplayStartedAt = (): number => {
    const now = Date.now();
    if (isNested || !programSongPlayback) {
      return now;
    }

    const targetItemId =
      sequence.mode === 'autoplay' ? (runtimeActiveItemId ?? sequence.activeItemId ?? null) : (runtimeActiveItemId ?? sequence.activeItemId ?? null);
    if (!targetItemId) {
      return now;
    }

    const targetItem = sequence.items.find((item) => item.id === targetItemId);
    if (!targetItem || targetItem.kind !== 'preset') {
      return now;
    }

    const itemAudioUrl = targetItem.audioUrl?.trim() || '';
    const playbackAudioUrl = programSongPlayback.audioUrl.trim();
    const playbackToken = programSongPlayback.token;
    const matchesPlayback =
      (itemAudioUrl && playbackAudioUrl && itemAudioUrl === playbackAudioUrl) || (targetItem.id && playbackToken.startsWith(`${targetItem.id}:`));
    if (!matchesPlayback) {
      return now;
    }

    const playbackOffsetMs = Math.max(0, Math.round(programSongPlayback.currentTimeMs));
    return now - playbackOffsetMs;
  };

  return (
    <div className={`flex flex-col overflow-hidden rounded-xl ${isNested ? 'border border-sand/30 bg-dark-sand/70' : 'h-full min-h-0 bg-dark-sand'}`}>
      {/* Two-column layout container */}
      <div className='flex min-h-0 flex-1 flex-col md:flex-row'>
        {/* Left Column: Playlist Queue */}
        {showQueue ? (
          <div className={`flex min-h-0 flex-1 flex-col ${showCatalog ? 'border-r-0 border-sand/30 md:border-r' : ''}`}>
            {showQueueHeading ? (
              <div className='flex items-center justify-between border-b border-sand/30 bg-dark-sand/70 px-4 py-2 border-t border-sand/20'>
                <span className='text-[10px] font-semibold uppercase tracking-widest text-text-secondary'>Playlist</span>
                <span className='text-[10px] text-text-secondary'>
                  {sequence.items.length} {sequence.items.length === 1 ? 'song' : 'songs'}
                </span>
              </div>
            ) : null}

            {sequence.items.length === 0 ? (
              <div className='flex flex-1 flex-col items-center justify-center px-4 py-16 text-center'>
                <Music2 size={32} className='mb-3 text-text-secondary' />
                <p className='text-sm font-medium text-text-primary'>Queue is empty</p>
                <p className='mt-1 text-xs text-text-secondary'>Search and add songs from the catalog panel.</p>
              </div>
            ) : (
              <div className='min-h-0 flex-1 overflow-auto'>
                <div className='min-w-100'>
                  {/* Column header */}
                  <div className='grid grid-cols-[28px_28px_1fr_52px_56px] items-center border-b border-sand/30 px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest text-text-secondary'>
                    <span />
                    <span className='text-center'>#</span>
                    <span style={{ paddingLeft: '50px' }}>Title</span>
                    <span className='flex items-center justify-end pr-3'>
                      <Clock size={10} />
                    </span>
                    <span />
                  </div>

                  <div className='divide-y divide-sand/20'>
                    {sequence.items.map((item, index) => {
                      const displayItem = item;
                      const isActive = displayItem.id === runtimeActiveItemId;
                      const isExpanded = displayItem.kind === 'preset' && expandedItemId === displayItem.id;
                      const selectedCatalogSong =
                        displayItem.kind === 'preset'
                          ? availableSongCatalog.find((song) => {
                              if (displayItem.audioUrl && song.audioUrl === displayItem.audioUrl) {
                                return true;
                              }

                              const sameArtist = (song.artist || '').trim() === displayItem.artist.trim();
                              const sameTitle = (song.title || '').trim() === displayItem.title.trim();
                              const sameCover = (song.coverUrl || '').trim() === displayItem.coverUrl.trim();
                              return sameArtist && sameTitle && sameCover;
                            })
                          : null;
                      const selectedCatalogSongValue = selectedCatalogSong ? String(selectedCatalogSong.id) : '';
                      const titleText = displayItem.kind === 'preset' ? displayItem.title.trim() : displayItem.label.trim();
                      const artistText = displayItem.kind === 'preset' ? displayItem.artist.trim() : '';
                      const rowDuration = displayItem.kind === 'preset' ? formatDurationFromMs(displayItem.durationMs) : '—';
                      const coverUrl = displayItem.kind === 'preset' ? displayItem.coverUrl.trim() : '';

                      return (
                        <div
                          key={displayItem.id}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (draggingIndex !== null) {
                              reorderItems(draggingIndex, index);
                            }
                            setDraggingIndex(null);
                          }}
                        >
                          {/* Main track row */}
                          <div
                            className={`group grid grid-cols-[28px_28px_1fr_52px_56px] items-center px-3 py-1.5 transition-colors ${
                              isActive ? 'bg-sea/15' : 'hover:bg-dark-sand/70'
                            }`}
                          >
                            {/* Drag handle — hidden until hover */}
                            <span
                              draggable
                              onDragStart={() => setDraggingIndex(index)}
                              onDragEnd={() => setDraggingIndex(null)}
                              className='inline-flex h-6 w-6 cursor-grab select-none items-center justify-center text-text-secondary opacity-0 transition-opacity group-hover:opacity-100'
                              title='Drag to reorder'
                              aria-label='Drag to reorder'
                            >
                              <GripVertical size={12} strokeWidth={2} />
                            </span>

                            {/* Track number / eq bars / take-on-hover */}
                            <IconButton
                              type='button'
                              onClick={() => {
                                void activateItem(displayItem.id);
                              }}
                              className='relative flex h-6 w-6 shrink-0 items-center justify-center border-0 bg-transparent p-0 shadow-none hover:translate-y-0 hover:scale-100'
                              title='Take on air'
                              aria-label='Take on air'
                            >
                              {/* Number — visible by default when not active, hidden on hover */}
                              <span
                                className={`text-xs tabular-nums transition-opacity ${isActive ? 'opacity-0' : 'text-text-secondary group-hover:opacity-0'}`}
                              >
                                {index + 1}
                              </span>
                              {/* EQ bars — only when active */}
                              {isActive && (
                                <span className='absolute inset-0 flex items-end justify-center gap-0.5 pb-0.5 group-hover:opacity-0'>
                                  <span className='w-0.75 rounded-sm bg-sea opacity-100' style={{ animation: 'eq-bar1 0.8s ease-in-out infinite alternate' }} />
                                  <span
                                    className='w-0.75 rounded-sm bg-sea opacity-100'
                                    style={{ animation: 'eq-bar2 0.8s ease-in-out 0.15s infinite alternate' }}
                                  />
                                  <span
                                    className='w-0.75 rounded-sm bg-sea opacity-100'
                                    style={{ animation: 'eq-bar1 0.8s ease-in-out 0.3s infinite alternate' }}
                                  />
                                </span>
                              )}
                              {/* Play icon — shows on hover always */}
                              <span className='absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100'>
                                <Play size={11} className='fill-text-primary text-text-primary' />
                              </span>
                            </IconButton>

                            {/* Cover art + title + artist */}
                            <div className='flex min-w-0 items-center gap-2.5 pl-1'>
                              {coverUrl ? (
                                <img src={coverUrl} alt={`${artistText} - ${titleText}`} className='h-9 w-9 shrink-0 rounded-sm object-cover shadow-md' />
                              ) : (
                                <div className='flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-dark-sand text-xs font-bold text-text-secondary'>
                                  {titleText.slice(0, 1).toUpperCase() || '?'}
                                </div>
                              )}
                              <div className='min-w-0'>
                                <div className={`truncate text-[13px] font-medium leading-tight ${isActive ? 'text-sea' : 'text-text-primary'}`}>
                                  {titleText}
                                </div>
                                <div className='truncate text-[11px] leading-tight text-text-secondary mt-0.5'>{artistText}</div>
                              </div>
                            </div>

                            {/* Duration */}
                            <span className={`text-right pr-3 text-xs tabular-nums ${isActive ? 'text-sea' : 'text-text-secondary'}`}>{rowDuration}</span>

                            {/* Hover actions */}
                            <div className='flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100'>
                              {displayItem.kind === 'preset' ? (
                                <IconButton
                                  type='button'
                                  onClick={() => setExpandedItemId((prev) => (prev === displayItem.id ? null : displayItem.id))}
                                  className='flex h-6 w-6 items-center justify-center rounded border-0 bg-transparent p-0 text-text-secondary shadow-none transition-colors hover:translate-y-0 hover:scale-100 hover:text-text-primary'
                                  title='Edit song'
                                  aria-label='Edit song'
                                >
                                  <svg
                                    width='13'
                                    height='13'
                                    viewBox='0 0 24 24'
                                    fill='none'
                                    stroke='currentColor'
                                    strokeWidth='2'
                                    strokeLinecap='round'
                                    strokeLinejoin='round'
                                  >
                                    <path d='M12 20h9' />
                                    <path d='M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z' />
                                  </svg>
                                </IconButton>
                              ) : null}
                              <IconButton
                                type='button'
                                onClick={() => removeItem(index)}
                                className='flex h-6 w-6 items-center justify-center rounded border-0 bg-transparent p-0 text-text-secondary shadow-none transition-colors hover:translate-y-0 hover:scale-100 hover:text-terracotta'
                                title='Remove'
                                aria-label='Remove'
                              >
                                <svg
                                  width='13'
                                  height='13'
                                  viewBox='0 0 24 24'
                                  fill='none'
                                  stroke='currentColor'
                                  strokeWidth='2'
                                  strokeLinecap='round'
                                  strokeLinejoin='round'
                                >
                                  <polyline points='3 6 5 6 21 6' />
                                  <path d='M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' />
                                  <path d='M10 11v6' />
                                  <path d='M14 11v6' />
                                  <path d='M9 6V4h6v2' />
                                </svg>
                              </IconButton>
                            </div>
                          </div>

                          {/* Expanded edit panel */}
                          {displayItem.kind === 'preset' && isExpanded ? (
                            <div className='border-t border-sand/30 bg-dark-sand/60 px-3 py-2'>
                              <div className='flex items-center rounded'>
                                <Select
                                  value={selectedCatalogSongValue}
                                  options={catalogOptions}
                                  placeholder='Swap song...'
                                  onChange={(value) => {
                                    const songId = Number(value);
                                    if (!Number.isFinite(songId) || songId <= 0) return;
                                    const selectedSong = availableSongCatalog.find((song) => song.id === songId);
                                    if (!selectedSong) return;
                                    applyCatalogSongToItem(index, displayItem, selectedSong);
                                    setExpandedItemId(null);
                                  }}
                                />
                              </div>
                            </div>
                          ) : null}

                          {displayItem.kind === 'sequence' ? (
                            <div className='border-t border-sand/30 bg-dark-sand/70 px-4 py-3'>
                              <p className='mb-2 text-xs text-text-secondary'>Legacy nested sequence. Flatten if possible.</p>
                              <ProgramSongSequenceEditor
                                sequence={displayItem.sequence}
                                songCatalog={songCatalog}
                                depth={depth + 1}
                                onChange={(nextNestedSequence) =>
                                  updateItem(index, {
                                    ...displayItem,
                                    sequence: nextNestedSequence
                                  })
                                }
                                onTakeSelection={async (nextNestedSequence) => {
                                  const nextSequence = {
                                    ...sequence,
                                    items: sequence.items.map((entry, sequenceIndex) =>
                                      sequenceIndex === index ? { ...displayItem, sequence: nextNestedSequence } : entry
                                    )
                                  };
                                  applySequence(nextSequence);
                                  if (onTakeSelection) {
                                    await onTakeSelection(nextSequence);
                                  }
                                  scheduleAutoTakeOffForSequence(nextSequence);
                                }}
                              />
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : null}

        {/* Right Column: Catalog Inventory */}
        {showCatalog ? (
          <div
            className={`flex min-h-0 flex-col border-t border-sand/30 bg-dark-sand/70 ${showQueue ? 'hidden w-[320px] shrink-0 md:flex' : 'min-h-0 flex-1'}`}
          >
            <div className='border-b border-sand/30 bg-dark-sand/80 p-2'>
              <Input
                type='text'
                placeholder='Search catalog to add...'
                value={addSongValue}
                onChange={(e) => setAddSongValue(e.target.value)}
                className='w-full rounded-md border border-sand/30 bg-dark-sand px-3 py-1.5 text-xs text-text-primary placeholder:text-text-secondary focus:border-sea/60 focus:outline-none focus:ring-1 focus:ring-sea/40'
              />
            </div>
            <div className={showQueue ? 'min-h-0 flex-1 overflow-y-auto' : 'max-h-125 overflow-y-auto'}>
              {availableSongCatalog
                .filter((song) => {
                  if (!addSongValue) return true;
                  const search = addSongValue.toLowerCase();
                  return song.title?.toLowerCase().includes(search) || song.artist?.toLowerCase().includes(search);
                })
                .slice(0, 80)
                .map((song) => (
                  <div key={song.id} className='group flex items-center justify-between border-b border-sand/20 px-3 py-2 hover:bg-dark-sand/70'>
                    <div className='flex min-w-0 items-center gap-2'>
                      {song.coverUrl ? (
                        <img src={song.coverUrl} alt='' className='h-8 w-8 shrink-0 rounded-sm object-cover opacity-80' />
                      ) : (
                        <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-dark-sand text-text-secondary'>
                          {song.title?.charAt(0) || <Music2 size={12} />}
                        </div>
                      )}
                      <div className='min-w-0 pr-2'>
                        <div className='truncate text-[11px] font-medium text-text-primary'>{song.title}</div>
                        <div className='truncate text-[10px] text-text-secondary'>{song.artist}</div>
                      </div>
                    </div>
                    <IconButton
                      type='button'
                      onClick={() => addItemFromCatalog(song.id)}
                      className='flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-0 bg-transparent p-0 text-text-secondary opacity-0 shadow-none transition-all hover:translate-y-0 hover:scale-100 hover:bg-sea/20 hover:text-sea group-hover:opacity-100'
                      title='Add to queue'
                      aria-label='Add to queue'
                    >
                      <Plus size={14} />
                    </IconButton>
                  </div>
                ))}
              {availableSongCatalog.length > 0 &&
                availableSongCatalog.filter(
                  (song) =>
                    !addSongValue ||
                    song.title?.toLowerCase().includes(addSongValue.toLowerCase()) ||
                    song.artist?.toLowerCase().includes(addSongValue.toLowerCase())
                ).length === 0 && <div className='p-4 text-center text-xs text-text-secondary'>No matches found</div>}
            </div>
          </div>
        ) : null}
      </div>

      {hasFixedPlaybackBar ? <div aria-hidden='true' className={`${showSceneQuickBar ? 'h-32' : 'h-20'} shrink-0`} /> : null}

      {/* Playback Bar */}
      {showPlaybackBar ? (
        <div
          className={
            hasFixedPlaybackBar
              ? 'fixed inset-x-0 bottom-0 z-40 bg-dark-sand/95 shadow-[0_-10px_28px_rgba(0,0,0,0.45)] backdrop-blur supports-[backdrop-filter]:bg-dark-sand/90'
              : ''
          }
        >
          {showSceneQuickBar ? (
            <div className='border-t border-sand/30 bg-dark-sand/90 px-4 py-2'>
              <div className='flex items-center gap-2 overflow-x-auto'>
                {sceneQuickActions.map((sceneAction) => (
                  <Button
                    key={sceneAction.id}
                    onClick={() => onStageScene?.(sceneAction.id)}
                    onDoubleClick={() => onTakeScene?.(sceneAction.id)}
                    title={`${sceneAction.name} (click to stage, double-click to take)`}
                    variant='ghost'
                    size='sm'
                    className={`relative min-w-[150px] max-w-[240px] shrink-0 overflow-hidden rounded border px-2 py-1.5 text-left text-[11px] font-medium leading-tight transition-colors ${
                      sceneAction.isActive
                        ? 'border-terracotta/80 bg-terracotta/35 text-white ring-1 ring-terracotta/50 dark:border-terracotta/90 dark:bg-terracotta/45 dark:text-white dark:ring-terracotta/60'
                        : sceneAction.isStaged
                          ? 'border-accent-blue/80 bg-accent-blue/35 text-white ring-1 ring-accent-blue/50 dark:border-accent-blue/90 dark:bg-accent-blue/45 dark:text-white dark:ring-accent-blue/60'
                          : 'border-sand/25 bg-dark-sand/80 text-text-primary hover:border-sea/40 hover:bg-sea/10 dark:border-sand/20 dark:bg-dark-sand/70 dark:text-text-primary dark:hover:border-sea/40'
                    }`}
                  >
                    <span className='mb-0.5 block font-mono text-[9px] opacity-50'>{sceneAction.shortcutLabel}</span>
                    <span className='line-clamp-2'>{sceneAction.name}</span>
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
          <div className='flex items-center justify-between border-t border-sand/30 bg-dark-sand/85 px-4 py-3'>
            {/* Transport controls */}
            <div className='flex items-center gap-2'>
              <IconButton
                type='button'
                title='Previous'
                disabled={runtimeActiveItemIndex <= 0}
                onClick={() => {
                  const idx = runtimeActiveItemIndex;
                  if (idx > 0) {
                    void activateItem(sequence.items[idx - 1].id);
                  }
                }}
                className='flex h-8 w-8 items-center justify-center rounded-full border-0 bg-transparent p-0 text-text-secondary shadow-none transition-colors hover:translate-y-0 hover:scale-100 hover:text-text-primary disabled:opacity-30'
                aria-label='Previous'
              >
                <SkipBack size={16} fill='currentColor' />
              </IconButton>

              <IconButton
                type='button'
                title={runtimeActiveItemId ? 'Next / Advance' : 'Play'}
                onClick={() => {
                  if (!runtimeActiveItemId && sequence.items.length > 0) {
                    void activateItem(sequence.items[0].id);
                  } else if (runtimeActiveItemId) {
                    const idx = sequence.items.findIndex((i) => i.id === runtimeActiveItemId);
                    if (idx < sequence.items.length - 1) {
                      void activateItem(sequence.items[idx + 1].id);
                    } else {
                      void activateItem(sequence.items[0].id);
                    }
                  }
                }}
                className='flex h-10 w-10 items-center justify-center rounded-full border-0 bg-sea p-0 text-white shadow-lg transition-transform hover:translate-y-0 hover:scale-105 hover:bg-accent-blue active:scale-95'
                aria-label={runtimeActiveItemId ? 'Next / Advance' : 'Play'}
              >
                <Play size={18} fill='currentColor' className='ml-0.5' />
              </IconButton>

              <IconButton
                type='button'
                title='Stop / Take Off Air'
                onClick={() => {
                  void clearActiveItem();
                }}
                className='flex h-8 w-8 items-center justify-center rounded-full border-0 bg-transparent p-0 text-text-secondary shadow-none transition-colors hover:translate-y-0 hover:scale-100 hover:text-text-primary'
                aria-label='Stop / Take Off Air'
              >
                <Square size={16} fill='currentColor' />
              </IconButton>

              <IconButton
                type='button'
                title='Next'
                disabled={runtimeActiveItemIndex < 0 || runtimeActiveItemIndex >= sequence.items.length - 1}
                onClick={() => {
                  const idx = runtimeActiveItemIndex;
                  if (idx < sequence.items.length - 1) {
                    void activateItem(sequence.items[idx + 1].id);
                  }
                }}
                className='flex h-8 w-8 items-center justify-center rounded-full border-0 bg-transparent p-0 text-text-secondary shadow-none transition-colors hover:translate-y-0 hover:scale-100 hover:text-text-primary disabled:opacity-30'
                aria-label='Next'
              >
                <SkipForward size={16} fill='currentColor' />
              </IconButton>
            </div>

            {/* Now playing info + progress */}
            <div className='hidden min-w-0 flex-1 px-4 md:block'>
              {runtimeActiveItemId ? (
                (() => {
                  // Prefer real playback identity, then sequence timing fallback.
                  const displayItem = sequence.items.find((i) => i.id === runtimeActiveItemId);
                  if (!displayItem || displayItem.kind !== 'preset') return null;

                  const displayAudioUrl = displayItem.audioUrl?.trim() || '';
                  const playbackAudioUrl = programSongPlayback?.audioUrl?.trim() || '';
                  const playbackToken = programSongPlayback?.token || '';
                  const playbackMatchesDisplaySong =
                    !isNested &&
                    !!programSongPlayback &&
                    ((displayAudioUrl && playbackAudioUrl && displayAudioUrl === playbackAudioUrl) ||
                      (displayItem.id && playbackToken.startsWith(`${displayItem.id}:`)) ||
                      (runtimeActiveItemId === displayItem.id && programSongPlayback.isPlaying));

                  // Compute how far into the current song we are
                  let songElapsedMs = 0;
                  let songStartedAt = typeof sequence.startedAt === 'number' ? sequence.startedAt : nowMs;

                  if (playbackMatchesDisplaySong && programSongPlayback) {
                    songElapsedMs = Math.max(0, programSongPlayback.currentTimeMs);
                    songStartedAt = Math.max(0, nowMs - songElapsedMs);
                  } else if (programSongPlayback?.isPlaying) {
                    songElapsedMs = Math.max(0, programSongPlayback.currentTimeMs);
                    songStartedAt = Math.max(0, nowMs - songElapsedMs);
                  } else if (sequence.mode === 'autoplay' && typeof sequence.startedAt === 'number') {
                    const seqStartedAt = sequence.startedAt;
                    const totalElapsed = Math.max(0, nowMs - seqStartedAt);
                    const baseIndex = sequence.items.findIndex((i) => i.id === runtimeActiveItemId);
                    const startIdx = baseIndex >= 0 ? baseIndex : 0;
                    const itemDurations = sequence.items.map((item) =>
                      item.kind === 'preset' && typeof item.durationMs === 'number' && item.durationMs > 0 ? item.durationMs : null
                    );
                    const allKnown = itemDurations.every((d) => d !== null);
                    let remaining = totalElapsed;
                    let cycleOffset = 0;
                    if (allKnown && sequence.loop !== false) {
                      const cycleDuration = itemDurations.reduce((s, d) => s + (d ?? 0), 0);
                      if (cycleDuration > 0) {
                        remaining = totalElapsed % cycleDuration;
                        cycleOffset = totalElapsed - remaining;
                      }
                    }
                    let cumulativeOffset = 0;
                    for (let step = 0; step < sequence.items.length; step++) {
                      const idx = (startIdx + step) % sequence.items.length;
                      const dur = itemDurations[idx];
                      if (dur === null || remaining < dur) {
                        songStartedAt = seqStartedAt + cycleOffset + cumulativeOffset;
                        songElapsedMs = remaining;
                        break;
                      }
                      remaining -= dur;
                      cumulativeOffset += dur;
                    }
                  } else {
                    songElapsedMs = Math.max(0, nowMs - songStartedAt);
                  }

                  const totalMs =
                    programSongPlayback?.isPlaying && typeof programSongPlayback.durationMs === 'number'
                      ? programSongPlayback.durationMs
                      : typeof displayItem.durationMs === 'number' && displayItem.durationMs > 0
                        ? displayItem.durationMs
                        : null;
                  const hasProgressTimeline = totalMs !== null && totalMs > 0;
                  const clampedSongElapsedMs = hasProgressTimeline ? Math.max(0, Math.min(songElapsedMs, totalMs)) : Math.max(0, songElapsedMs);
                  const progressRatio = hasProgressTimeline ? Math.max(0, Math.min(1, clampedSongElapsedMs / totalMs)) : 0;

                  const fmt = (ms: number) => {
                    const s = Math.floor(ms / 1000);
                    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
                  };
                  return (
                    <div className='relative overflow-hidden rounded-lg border border-sand/30 bg-dark-sand/80'>
                      {/* Fill progress from direct playback ratio (avoids animation jitter). */}
                      {hasProgressTimeline && (
                        <div
                          className='pointer-events-none absolute inset-0 origin-left bg-sea/20'
                          style={{
                            transform: `scaleX(${progressRatio})`,
                            transition: 'transform 90ms linear'
                          }}
                        />
                      )}
                      <div className='relative flex items-center gap-2 px-3 py-2'>
                        {displayItem.coverUrl ? (
                          <img src={displayItem.coverUrl} alt='' className='h-8 w-8 shrink-0 rounded-sm object-cover' />
                        ) : (
                          <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-dark-sand'>
                            <Music2 size={11} className='text-text-secondary' />
                          </div>
                        )}
                        <div className='min-w-0 flex-1'>
                          <div className='truncate text-xs font-semibold text-sea'>{displayItem.title || ''}</div>
                          <div className='truncate text-[10px] text-text-secondary'>{displayItem.artist || ''}</div>
                        </div>
                        <div className='shrink-0 text-right text-[10px] tabular-nums text-text-secondary'>
                          {hasProgressTimeline && (
                            <span>
                              {fmt(clampedSongElapsedMs)}
                              <span className='text-text-secondary/70'> / {fmt(totalMs)}</span>
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })()
              ) : (
                <p className='text-[11px] text-text-secondary'>Nothing on air</p>
              )}
            </div>

            {/* Mode and loop toggles */}
            <div className='flex items-center gap-3'>
              <div className='flex items-center gap-0.5 rounded-lg border border-sand/30 bg-dark-sand/80 p-0.5'>
                <Button
                  onClick={() =>
                    applySequence({
                      ...sequence,
                      mode: 'manual',
                      activeItemId:
                        sequence.mode === 'autoplay' ? (runtimeActiveItemId ?? sequence.activeItemId) : (runtimeActiveItemId ?? sequence.activeItemId),
                      startedAt: Date.now()
                    })
                  }
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    sequence.mode === 'manual' ? 'bg-sea/20 text-sea shadow-sm' : 'text-text-secondary hover:text-text-primary'
                  }`}
                  size='sm'
                  variant='secondary'
                >
                  Manual
                </Button>
                <Button
                  onClick={() =>
                    applySequence({
                      ...sequence,
                      mode: 'autoplay',
                      activeItemId:
                        sequence.mode === 'autoplay' ? (runtimeActiveItemId ?? sequence.activeItemId) : (runtimeActiveItemId ?? sequence.activeItemId),
                      startedAt: resolveAutoplayStartedAt()
                    })
                  }
                  className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    sequence.mode === 'autoplay' ? 'bg-sea/20 text-sea' : 'text-text-secondary hover:text-text-primary'
                  }`}
                  size='sm'
                  variant='secondary'
                >
                  <Play size={9} fill='currentColor' />
                  Autoplay
                </Button>
              </div>

              <IconButton
                type='button'
                title='Loop'
                onClick={() => applySequence({ ...sequence, loop: sequence.loop === false ? true : false })}
                className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                  sequence.loop !== false ? 'text-sea bg-sea/10' : 'text-text-secondary hover:text-text-primary'
                }`}
                aria-label='Loop'
              >
                <Repeat2 size={16} />
              </IconButton>

              {onStopAllInstants && (
                <IconButton
                  type='button'
                  title='Stop All Instants'
                  onClick={() => onStopAllInstants()}
                  className='flex h-8 w-8 items-center justify-center rounded-full transition-colors text-text-secondary hover:text-terracotta hover:bg-terracotta/10'
                  aria-label='Stop All Instants'
                >
                  <ZapOff size={16} />
                </IconButton>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
