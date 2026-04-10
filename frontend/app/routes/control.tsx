import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Kbd, SectionHeader, Select, Switch } from '@gaulatti/bleecker';
import { Clock, GripVertical, Music2, Play, Plus, Repeat2, SkipBack, SkipForward, Square } from 'lucide-react';
import type { Route } from './+types/control';
import { apiUrl } from '../utils/apiBaseUrl';
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

interface ProgramState {
  id: number;
  programId: string;
  activeSceneId: number | null;
  activeScene?: Scene | null;
  stagedSceneId?: number | null;
  stagedScene?: Scene | null;
  scenes: ProgramSceneEntry[];
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

const hasConfigurableSceneAttributes = (componentType: string): boolean => {
  switch (componentType) {
    case 'ticker':
    case 'header':
    case 'qr-code':
    case 'slideshow':
    case 'video-stream':
    case 'broadcast-layout':
    case 'clock-widget':
    case 'reloj-clock':
    case 'reloj-loop-clock':
    case 'toni-chyron':
    case 'fifthbell-chyron':
    case 'toni-clock':
    case 'fifthbell-clock':
    case 'modoitaliano-chyron':
    case 'modoitaliano-disclaimer':
    case 'cronica-background':
    case 'cronica-chyron':
    case 'cronica-reiteramos':
    case 'earone':
    case 'fifthbell-content':
    case 'fifthbell-marquee':
    case 'fifthbell-corner':
    case 'fifthbell':
      return true;
    default:
      return false;
  }
};

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
        <label className='text-sm text-gray-700'>
          <span className='block text-xs text-gray-500 mb-1'>Interval (ms)</span>
          <input
            type='number'
            min={1000}
            step={100}
            value={typeof props.intervalMs === 'number' ? props.intervalMs : 5000}
            onChange={(event) => updateProp(componentType, 'intervalMs', Math.max(1000, Number(event.target.value) || 5000))}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
          />
        </label>
        <label className='text-sm text-gray-700'>
          <span className='block text-xs text-gray-500 mb-1'>Transition (ms)</span>
          <input
            type='number'
            min={100}
            step={50}
            value={typeof props.transitionMs === 'number' ? props.transitionMs : 900}
            onChange={(event) => updateProp(componentType, 'transitionMs', Math.max(100, Number(event.target.value) || 900))}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
          />
        </label>
        <label className='text-sm text-gray-700'>
          <span className='block text-xs text-gray-500 mb-1'>Fit Mode</span>
          <select
            value={props.fitMode === 'contain' ? 'contain' : 'cover'}
            onChange={(event) => updateProp(componentType, 'fitMode', event.target.value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
          >
            <option value='cover'>Cover</option>
            <option value='contain'>Contain</option>
          </select>
        </label>
        <div className='flex flex-col justify-end gap-2 pb-1'>
          <label className='flex items-center gap-2 text-sm text-gray-700'>
            <input
              type='checkbox'
              checked={asBoolean(props.shuffle, false)}
              onChange={(event) => updateProp(componentType, 'shuffle', event.target.checked)}
              className='h-4 w-4'
            />
            Shuffle
          </label>
          <label className='flex items-center gap-2 text-sm text-gray-700'>
            <input
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
        <label className='block text-xs text-gray-600'>Media Group Source</label>
        <select
          value={selectedMediaGroupId !== null ? String(selectedMediaGroupId) : ''}
          onChange={(event) => {
            const nextGroupId = normalizeSlideshowMediaGroupId(event.target.value);
            updateProp(componentType, 'mediaGroupId', nextGroupId);
          }}
          className='w-full rounded border border-slate-300 px-3 py-2 text-sm focus:ring-2 focus:ring-green-500'
        >
          <option value=''>Manual images in scene metadata</option>
          {mediaGroups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name} ({group.items.length} images)
            </option>
          ))}
        </select>
        <p className='text-xs text-gray-500'>
          {isLoadingMediaGroups
            ? 'Loading media groups...'
            : usesMediaGroup
              ? 'This slideshow now follows the selected media group.'
              : 'Tip: select a media group to reuse image sets across scenes.'}
        </p>
      </div>

      {!usesMediaGroup ? (
        <div className='space-y-2'>
          <label className='block text-xs text-gray-600'>Upload images</label>
          <input
            type='file'
            accept='image/*'
            multiple
            disabled={isUploading}
            onChange={(event) => {
              const files = event.target.files ? Array.from(event.target.files) : [];
              event.target.value = '';
              void uploadImages(files);
            }}
            className='block w-full text-xs text-gray-500 file:mr-3 file:rounded file:border file:border-slate-300 file:bg-white file:px-2 file:py-1 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-100'
          />
          <p className='text-xs text-gray-500 mt-1'>1920x1080 images are recommended. Upload one or many files.</p>
          {isUploading ? <p className='text-xs text-gray-500'>Uploading image...</p> : null}
          {uploadError ? <p className='text-xs text-red-500'>{uploadError}</p> : null}
        </div>
      ) : null}

      {usesMediaGroup ? (
        <div className='space-y-2'>
          <p className='text-xs text-gray-600'>{selectedMediaGroup ? `Using group "${selectedMediaGroup.name}"` : 'Selected group not found.'}</p>
          {selectedMediaGroup && mediaGroupImages.length > 0 ? (
            <div className='grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2'>
              {mediaGroupImages.map((url, index) => (
                <div key={`${url}_${index}`} className='rounded border border-slate-200 bg-white p-2'>
                  <img src={url} alt={`Media group image ${index + 1}`} className='h-20 w-full rounded object-cover bg-slate-100' />
                </div>
              ))}
            </div>
          ) : (
            <p className='text-xs text-gray-500'>No images in this group yet. Add assets in the Media page.</p>
          )}
        </div>
      ) : images.length > 0 ? (
        <div className='grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2'>
          {images.map((url, index) => (
            <div key={`${url}_${index}`} className='rounded border border-slate-200 bg-white p-2 space-y-2'>
              <img src={url} alt={`Slideshow ${index + 1}`} className='h-20 w-full rounded object-cover bg-slate-100' />
              <button
                type='button'
                onClick={() => {
                  setImages(images.filter((_, imageIndex) => imageIndex !== index));
                }}
                className='w-full rounded border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50'
              >
                Remove
              </button>
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

function getSceneSummaryText(scene: Scene): string {
  try {
    const metadata = parseSceneMetadata(scene.metadata);
    const toniProps = {
      ...(metadata?.['toni-chyron'] || {}),
      ...(metadata?.['fifthbell-chyron'] || {})
    };

    if (toniProps && typeof toniProps === 'object') {
      const sequence = normalizeToniChyronSequence(toniProps.sequence);
      const contentMode = getToniChyronContentMode(toniProps.contentMode, sequence);

      if (contentMode === 'sequence' && sequence) {
        return `Sequence (${countSequenceLeafItems(sequence)} items)`;
      }

      if (typeof toniProps.text === 'string' && toniProps.text.trim()) {
        return toniProps.text;
      }
    }

    const chyronProps = metadata?.chyron;
    if (chyronProps && typeof chyronProps === 'object' && typeof chyronProps.text === 'string' && chyronProps.text.trim()) {
      return chyronProps.text;
    }

    const broadcastProps = metadata?.['broadcast-layout'];
    if (broadcastProps && typeof broadcastProps === 'object' && typeof broadcastProps.chyronText === 'string' && broadcastProps.chyronText.trim()) {
      return broadcastProps.chyronText;
    }
  } catch (err) {
    console.error('Failed to parse scene metadata for summary:', err);
  }

  return '(none)';
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
  const [songCatalog, setSongCatalog] = useState<SongCatalogItem[]>([]);
  const [mediaGroups, setMediaGroups] = useState<MediaGroup[]>([]);
  const [isLoadingMediaGroups, setIsLoadingMediaGroups] = useState(false);
  const [instantDurationsMs, setInstantDurationsMs] = useState<Record<number, number | null>>({});
  const [instantPlayback, setInstantPlayback] = useState<Record<number, InstantPlaybackState>>({});
  const instantDurationByUrlRef = useRef<Record<string, number | null>>({});
  const instantPlaybackTimeoutsRef = useRef<Record<number, number>>({});
  const [layouts, setLayouts] = useState<Layout[]>([]);
  const [componentTypes, setComponentTypes] = useState<ComponentType[]>([]);
  const [selectedScene, setSelectedScene] = useState<number | null>(null);
  const [sceneEditorProps, setSceneEditorProps] = useState<Record<string, any>>({});
  const [isSavingSceneAttributes, setIsSavingSceneAttributes] = useState(false);
  const sceneEditorAutosaveTimerRef = useRef<number | null>(null);
  const sceneEditorAutosaveSignatureRef = useRef<string>('');
  const [editingScene, setEditingScene] = useState<Scene | null>(null);

  const [showSceneModal, setShowSceneModal] = useState(false);
  const [newSceneName, setNewSceneName] = useState('');
  const [selectedLayoutId, setSelectedLayoutId] = useState<number | null>(null);
  const [sceneComponentProps, setSceneComponentProps] = useState<Record<string, any>>({});
  const [sceneErrors, setSceneErrors] = useState({ name: '', layout: '', props: '' });
  const [isCreatingScene, setIsCreatingScene] = useState(false);
  const [selectedTransitionId] = useGlobalTransitionId();
  const [programAudioBusSettings, setProgramAudioBusSettings] = useState<ProgramAudioBusSettings>({
    songSequence: createProgramSongSequence('manual')
  });
  const [isSavingProgramAudioBus, setIsSavingProgramAudioBus] = useState(false);
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
  const [takePresetFadeMs, setTakePresetFadeMs] = useState<number>(1200);
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

  useEffect(() => {
    fetchScenes();
    fetchLayouts();
    fetchComponentTypes();
    fetchSongCatalog();
    fetchMediaGroups();
  }, []);

  useEffect(() => {
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
    mixerLevelsRef.current = mixerLevels;
  }, [mixerLevels]);

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

        if (payload.type === 'scene_change' || payload.type === 'program_scenes_changed') {
          const eventProgramId = typeof payload.programId === 'string' ? payload.programId : '';
          if (eventProgramId !== activeProgramId) {
            return;
          }
          const normalizedProgramState = normalizeProgramState(payload.state);
          syncProgramStateAndStagedScene(normalizedProgramState);
          return;
        }

        if (payload.type === 'scene_update') {
          const eventProgramId = typeof payload.programId === 'string' ? payload.programId : '';
          if (eventProgramId !== activeProgramId) {
            return;
          }
          setProgramState((prev) => {
            if (!prev) {
              return prev;
            }
            const nextScenes = prev.scenes.map((entry) => (entry.sceneId === payload.scene?.id ? { ...entry, scene: payload.scene } : entry));
            return {
              ...prev,
              scenes: nextScenes
            };
          });
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
  }, [activeProgramId, syncProgramStateAndStagedScene]);

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
    try {
      const res = await fetch(apiUrl('/layouts/component-types'));
      const data = await res.json();
      setComponentTypes(data);
    } catch (err) {
      console.error('Failed to fetch component types:', err);
    }
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

  const fetchMediaGroups = async () => {
    try {
      setIsLoadingMediaGroups(true);
      const res = await fetch(apiUrl('/media-groups'));
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
      const normalizedProgramState = normalizeProgramState(data);

      syncProgramStateAndStagedScene(normalizedProgramState);
    } catch (err) {
      console.error('Failed to fetch program state:', err);
      syncProgramStateAndStagedScene(null);
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

    await activateScene(selectedScene);
  };

  const takeSceneInstant = async (sceneId: number | null = selectedScene) => {
    const normalizedSceneId = typeof sceneId === 'number' && Number.isFinite(sceneId) ? sceneId : null;
    if (normalizedSceneId === null) {
      return;
    }

    try {
      const res = await fetch(apiUrl(`/program/${encodeURIComponent(activeProgramId)}/scene-instant/take`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneId: normalizedSceneId })
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
    };
  }, []);

  useEffect(() => {
    if (!selectedScene) {
      sceneEditorAutosaveSignatureRef.current = '';
      setSceneEditorProps({});
      return;
    }

    const scene = scenes.find((s) => s.id === selectedScene);
    if (!scene) {
      sceneEditorAutosaveSignatureRef.current = '';
      setSceneEditorProps({});
      return;
    }

    const nextProps = buildComponentPropsForScene(scene);
    sceneEditorAutosaveSignatureRef.current = JSON.stringify(nextProps);
    setSceneEditorProps(nextProps);
  }, [selectedScene, scenes]);

  const updateSceneEditorProp = (componentType: string, propName: string, value: any) => {
    setSceneEditorProps((prev) => ({
      ...prev,
      [componentType]: {
        ...prev[componentType],
        [propName]: value
      }
    }));
  };

  const replaceSceneEditorComponentProps = (componentType: string, nextProps: any) => {
    setSceneEditorProps((prev) => ({
      ...prev,
      [componentType]: nextProps
    }));
  };

  const persistSceneAttributes = async (nextSceneProps: ComponentPropsMap) => {
    if (!selectedScene) return;

    setIsSavingSceneAttributes(true);
    try {
      const selectedSceneData = scenes.find((scene) => scene.id === selectedScene);
      const existingMetadata = selectedSceneData ? parseSceneMetadata(selectedSceneData.metadata) : {};
      const nextMetadata = withIndependentProgramClockMetadata({
        ...existingMetadata,
        ...nextSceneProps
      });

      const response = await fetch(apiUrl(`/scenes/${selectedScene}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metadata: nextMetadata
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
    } catch (err) {
      console.error('Failed to update scene attributes:', err);
    } finally {
      setIsSavingSceneAttributes(false);
    }
  };

  const commitSceneEditorComponentProps = async (componentType: string, nextProps: any) => {
    const nextSceneProps = {
      ...sceneEditorProps,
      [componentType]: nextProps
    };
    setSceneEditorProps(nextSceneProps);
    await persistSceneAttributes(nextSceneProps);
  };

  useEffect(() => {
    if (!selectedScene) {
      return;
    }

    const serializedProps = JSON.stringify(sceneEditorProps);
    if (serializedProps === sceneEditorAutosaveSignatureRef.current) {
      return;
    }

    if (sceneEditorAutosaveTimerRef.current !== null) {
      window.clearTimeout(sceneEditorAutosaveTimerRef.current);
    }

    sceneEditorAutosaveTimerRef.current = window.setTimeout(() => {
      sceneEditorAutosaveTimerRef.current = null;
      const latestSerializedProps = JSON.stringify(sceneEditorProps);
      if (latestSerializedProps === sceneEditorAutosaveSignatureRef.current) {
        return;
      }

      sceneEditorAutosaveSignatureRef.current = latestSerializedProps;
      void persistSceneAttributes(sceneEditorProps);
    }, 350);

    return () => {
      if (sceneEditorAutosaveTimerRef.current !== null) {
        window.clearTimeout(sceneEditorAutosaveTimerRef.current);
        sceneEditorAutosaveTimerRef.current = null;
      }
    };
  }, [selectedScene, sceneEditorProps]);

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
    switch (componentType) {
      case 'ticker':
        return { hashtag: '#ModoSanremoMR', url: 'modoradio.cl' };
      case 'chyron':
        return { text: '', duration: 5000 };
      case 'header':
        return { title: '', date: new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }) };
      case 'clock-widget':
        return { showIcon: true, iconUrl: '', timezone: 'America/Argentina/Buenos_Aires' };
      case 'live-indicator':
        return { animate: true };
      case 'logo-widget':
        return { logoUrl: '', position: 'bottom-right' };
      case 'slideshow':
        return {
          mediaGroupId: null,
          images: [],
          intervalMs: 5000,
          transitionMs: 900,
          shuffle: false,
          fitMode: 'cover',
          kenBurns: true
        };
      case 'video-stream':
        return {
          sourceUrl: '',
          posterUrl: '',
          showControls: false,
          loop: false,
          autoPlay: true,
          objectFit: 'cover'
        };
      case 'qr-code':
        return { qrCodeUrl: '', placeholder: true, content: 'https://modoradio.cl' };
      case 'broadcast-layout':
        return {
          headerTitle: '',
          hashtag: '#ModoSanremoMR',
          url: 'modoradio.cl',
          qrCodeContent: 'https://modoradio.cl',
          clockTimezone: 'America/Argentina/Buenos_Aires',
          showChyron: false,
          chyronText: ''
        };
      case 'reloj-clock':
        return { timezone: 'America/Argentina/Buenos_Aires' };
      case 'reloj-loop-clock':
        return { timezone: 'Europe/Madrid' };
      case 'toni-chyron':
      case 'fifthbell-chyron':
        return { text: '', useMarquee: false, socialHandles: ['@modoitaliano.oficial', '@fifth.bell', '@hnmages'] };
      case 'toni-clock':
      case 'fifthbell-clock':
        return {
          showWorldClocks: true,
          showBellIcon: componentType === 'fifthbell-clock',
          worldClockRotateIntervalMs: 5000,
          worldClockTransitionMs: 300,
          worldClockShuffle: false,
          worldClockWidthPx: 200,
          worldClockCities: [
            { city: 'SANREMO', timezone: 'Europe/Rome' },
            { city: 'NEW YORK', timezone: 'America/New_York' },
            { city: 'MADRID', timezone: 'Europe/Madrid' },
            { city: 'MONTEVIDEO', timezone: 'America/Montevideo' },
            { city: 'SANTIAGO', timezone: 'America/Santiago' }
          ]
        };
      case 'modoitaliano-clock':
        return {};
      case 'modoitaliano-chyron':
        return {
          show: true,
          textSequence: createProgramTextSequence('manual', { includeMarquee: true }),
          ctaSequence: createProgramTextSequence('manual')
        };
      case 'modoitaliano-disclaimer':
        return {
          text: 'Contenuti a scopo informativo.',
          show: true,
          align: 'right',
          bottomPx: 24,
          fontSizePx: 20,
          opacity: 0.82
        };
      case 'cronica-background':
        return {};
      case 'cronica-chyron':
        return { text: '' };
      case 'cronica-reiteramos':
        return { text: 'REITERAMOS', show: true };
      case 'toni-logo':
        return {};
      case 'earone':
        return { label: 'EARONE', rank: '', spins: '' };
      case 'fifthbell-content':
        return {
          showArticles: true,
          showWeather: true,
          showEarthquakes: true,
          showMarkets: true,
          showCallsignTake: true,
          weatherCities: [...FIFTHBELL_AVAILABLE_WEATHER_CITIES],
          languageRotation: ['en', 'es', 'en', 'it'],
          dataLoadTimeoutMs: 15000,
          playlistDefaultDurationMs: 10000,
          playlistUpdateIntervalMs: 100,
          articlesDurationMs: 10000,
          weatherDurationMs: 5000,
          earthquakesDurationMs: 10000,
          marketsDurationMs: 10000,
          audioCueEnabled: true,
          audioCueMinute: 59,
          audioCueSecond: 55,
          callsignPrelaunchUntilNyc: '2026-01-02T21:30:00',
          callsignWindowStartSecond: 50,
          callsignWindowEndSecond: 3
        };
      case 'fifthbell-marquee':
        return {
          showMarquee: false,
          marqueeMinPostsCount: 4,
          marqueeMinAverageRelevance: 0,
          marqueeMinMedianRelevance: 0,
          marqueePixelsPerSecond: 150,
          marqueeMinDurationSeconds: 10,
          marqueeHeightPx: 72
        };
      case 'fifthbell-corner':
        return {
          showWorldClocks: true,
          showBellIcon: true,
          worldClockRotateIntervalMs: 7000,
          worldClockTransitionMs: 300,
          worldClockShuffle: true,
          worldClockWidthPx: 200
        };
      case 'fifthbell':
        return {
          ...getDefaultPropsForComponent('fifthbell-content'),
          ...getDefaultPropsForComponent('fifthbell-marquee'),
          ...getDefaultPropsForComponent('toni-clock')
        };
      default:
        return {};
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

      if (data.type === 'scene_change' || data.type === 'program_scenes_changed') {
        const normalizedProgramState = normalizeProgramState(data.state);
        syncProgramStateAndStagedScene(normalizedProgramState);
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
        setProgramState((prev) => {
          if (!prev) {
            return prev;
          }
          const nextScenes = prev.scenes.map((entry) => (entry.sceneId === data.scene?.id ? { ...entry, scene: data.scene } : entry));
          return {
            ...prev,
            scenes: nextScenes
          };
        });
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
    [activeProgramId, isProgramRealtimeConnected, syncProgramStateAndStagedScene]
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
  const activeSceneData = activeSceneId ? (assignedScenes.find((scene) => scene.id === activeSceneId) ?? null) : null;
  const stagedSceneSummaryText = useMemo(() => {
    if (!stagedSceneData) {
      return '';
    }
    return getSceneSummaryText(stagedSceneData);
  }, [stagedSceneData?.id, stagedSceneData?.metadata]);
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
  return (
    <div className='min-h-screen bg-light-sand p-6 dark:bg-deep-sea md:p-8'>
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
      <div className='mx-auto max-w-7xl space-y-6'>
        <SectionHeader title='Control' description='Stage scenes, take them live, and edit staged scene attributes for the selected program.' />

        <div className='space-y-6'>
          {/* Scenes Panel */}
          <Card className='space-y-4'>
            <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
              <h2 className='text-2xl font-semibold text-text-primary dark:text-text-primary'>Scenes</h2>
              <div className='flex flex-wrap items-center gap-2'>
                <Button size='sm' onClick={() => void takeStagedSceneLive()} disabled={!selectedScene || stagedIsOnAir}>
                  TAKE
                </Button>
                <Button size='sm' variant='secondary' onClick={() => window.location.assign('/scenes')}>
                  Manage Scenes
                </Button>
              </div>
            </div>
            <p className='flex items-center gap-2 text-xs text-text-secondary dark:text-text-secondary'>
              Hotkeys:
              <Kbd keys={['Ctrl', 'S']} />
              then
              <span>1-9 (0 for #10) to stage</span>
              <span>·</span>
              <Kbd keys={['Ctrl', 'Enter']} />
              <span>to TAKE</span>
            </p>
            {assignedScenes.length === 0 ? (
              <div className='py-8 text-center text-text-secondary dark:text-text-secondary'>No scenes assigned to this program.</div>
            ) : (
              <>
                <div className='overflow-x-auto'>
                  <div className='grid grid-flow-col auto-cols-[120px] grid-rows-1 gap-3 pb-1'>
                    {assignedScenes.map((scene, index) => {
                      const isStaged = selectedScene === scene.id;
                      const isActive = activeSceneId === scene.id;

                      return (
                        <button
                          key={scene.id}
                          type='button'
                          onClick={() => {
                            setSelectedScene(scene.id);
                            void stageSceneForProgram(scene.id);
                          }}
                          className={`relative aspect-square min-h-[120px] rounded-xl border p-3 text-left transition-colors ${
                            isActive && isStaged
                              ? 'border-emerald-500 bg-emerald-500/10 ring-2 ring-emerald-500/30 dark:border-emerald-400 dark:bg-emerald-400/10 dark:ring-emerald-400/20'
                              : isActive
                                ? 'border-red-500 bg-red-500/10 ring-2 ring-red-500/30 dark:border-red-400 dark:bg-red-400/10 dark:ring-red-400/20'
                                : isStaged
                                  ? 'border-sea bg-sea/10 ring-2 ring-sea/20 dark:border-accent-blue dark:bg-accent-blue/10 dark:ring-accent-blue/20'
                                  : 'border-sand/20 bg-white/80 hover:border-sea/40 dark:border-sand/40 dark:bg-dark-sand/60 dark:hover:border-accent-blue/50'
                          }`}
                          title={scene.name}
                        >
                          <span className='absolute left-2 top-2 inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-sea px-1 text-xs font-bold text-white dark:bg-accent-blue'>
                            {index + 1}
                          </span>
                          <div className='absolute right-2 top-2 flex gap-1'>
                            {isActive ? <span className='rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white'>PGM</span> : null}
                            {isStaged ? <span className='rounded bg-cyan-600 px-1.5 py-0.5 text-[10px] font-bold text-white'>STG</span> : null}
                          </div>
                          <div className='mt-6'>
                            <div className='line-clamp-2 text-sm font-semibold leading-tight text-text-primary dark:text-text-primary'>{scene.name}</div>
                            <div className='mt-1 line-clamp-1 text-xs text-text-secondary dark:text-text-secondary'>{scene.layout.name}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className='text-xs text-text-secondary dark:text-text-secondary space-y-1'>
                  <p>
                    Program: <span className='font-semibold text-text-primary dark:text-text-primary'>{activeSceneData?.name ?? 'Off Air'}</span>
                  </p>
                  <p>
                    Staged: <span className='font-semibold text-text-primary dark:text-text-primary'>{stagedSceneData?.name ?? 'None'}</span>
                    {stagedSceneData ? <> · Text: {stagedSceneSummaryText}</> : null}
                  </p>
                </div>
              </>
            )}
          </Card>

          <Card className='space-y-4'>
            <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
              <h2 className='text-2xl font-semibold text-text-primary dark:text-text-primary'>Playlist</h2>
              {isSavingProgramAudioBus ? <span className='text-xs text-text-secondary dark:text-text-secondary'>Saving…</span> : null}
            </div>
            <ProgramSongSequenceEditor
              sequence={programAudioBusSongSequence}
              songCatalog={songCatalog}
              programSongPlayback={programSongPlaybackState}
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
          </Card>

          <Card className='space-y-4'>
            <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
              <h2 className='text-2xl font-semibold text-text-primary dark:text-text-primary'>Mixer</h2>
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
                  <button
                    type='button'
                    onClick={toggleSceneInstantMuted}
                    className={`flex h-9 items-center justify-center rounded px-3 transition-all font-bold text-[11px] uppercase tracking-wider ${
                      mixerLevels.sceneInstantMuted
                        ? 'bg-red-600 text-white shadow-[0_0_12px_rgba(220,38,38,0.5)]'
                        : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-700 border border-zinc-700/50'
                    }`}
                  >
                    Mute
                  </button>
                  <button
                    type='button'
                    onClick={toggleSceneInstantSolo}
                    className={`flex h-9 items-center justify-center rounded px-3 transition-all font-bold text-[11px] uppercase tracking-wider ${
                      mixerLevels.sceneInstantSolo
                        ? 'bg-yellow-500 text-yellow-950 shadow-[0_0_12px_rgba(234,179,8,0.4)]'
                        : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-700 border border-zinc-700/50'
                    }`}
                  >
                    Solo
                  </button>
                </div>
                <label className='text-[10px] font-mono text-sky-300'>
                  <span className='mb-1 block text-center'>A (dB)</span>
                  <input
                    type='number'
                    step={0.1}
                    min={TAKE_VOLUME_PRESET_MIN_DB}
                    max={TAKE_VOLUME_PRESET_MAX_DB}
                    value={mixerTakePresetsDb.sceneInstant.aDb}
                    onChange={(event) => updateChannelTakePresetDb('sceneInstant', 'a', Number(event.target.value))}
                    className='w-20 rounded border border-sky-800/50 bg-zinc-900 px-1 py-1 text-center text-[10px] text-sky-200 outline-none focus:border-sky-400'
                  />
                </label>
                <label className='text-[10px] font-mono text-amber-300'>
                  <span className='mb-1 block text-center'>B (dB)</span>
                  <input
                    type='number'
                    step={0.1}
                    min={TAKE_VOLUME_PRESET_MIN_DB}
                    max={TAKE_VOLUME_PRESET_MAX_DB}
                    value={mixerTakePresetsDb.sceneInstant.bDb}
                    onChange={(event) => updateChannelTakePresetDb('sceneInstant', 'b', Number(event.target.value))}
                    className='w-20 rounded border border-amber-800/50 bg-zinc-900 px-1 py-1 text-center text-[10px] text-amber-200 outline-none focus:border-amber-400'
                  />
                </label>
                <div className='h-9 w-36 self-end rounded bg-zinc-950'>
                  <input
                    type='range'
                    min={0}
                    max={1}
                    step={0.01}
                    value={mixerLevels.sceneInstantMasterVolume}
                    onChange={(event) => setSceneInstantMasterVolume(Number(event.target.value))}
                    className='h-full w-full cursor-pointer'
                  />
                </div>
                <input
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
                <button
                  type='button'
                  onClick={() => triggerChannelTake('sceneInstant')}
                  disabled={isApplyingTakePresetByChannel.sceneInstant}
                  className='h-9 rounded border border-violet-800/50 bg-zinc-900 px-3 text-[10px] font-bold tracking-wider text-violet-300 transition hover:bg-violet-900/20 disabled:opacity-50'
                >
                  TAKE {sceneInstantTakeTargetSide.toUpperCase()}
                </button>
                <div className='min-w-[120px] text-right'>
                  <p className='text-[11px] text-zinc-400'>
                    Meter {Math.round(sceneInstantMeterFill * 100)}% / {Math.round(sceneInstantPeakFill * 100)}%
                  </p>
                  <p className='text-[11px] text-zinc-500'>
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
                      <button
                        type='button'
                        onClick={toggleSongMuted}
                        className={`flex h-9 w-full items-center justify-center rounded transition-all font-bold text-[11px] uppercase tracking-wider ${
                          mixerLevels.songMuted
                            ? 'bg-red-600 text-white shadow-[0_0_12px_rgba(220,38,38,0.5)]'
                            : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-700 border border-zinc-700/50'
                        }`}
                      >
                        Mute
                      </button>
                      <button
                        type='button'
                        onClick={toggleSongSolo}
                        className={`flex h-9 w-full items-center justify-center rounded transition-all font-bold text-[11px] uppercase tracking-wider ${
                          mixerLevels.songSolo
                            ? 'bg-yellow-500 text-yellow-950 shadow-[0_0_12px_rgba(234,179,8,0.4)]'
                            : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-700 border border-zinc-700/50'
                        }`}
                      >
                        Solo
                      </button>
                    </div>
                    <div className='mt-2 grid w-full grid-cols-2 gap-2 px-5'>
                      <label className='text-[10px] font-mono text-sky-300'>
                        <span className='mb-1 block text-center'>A</span>
                        <input
                          type='number'
                          step={0.1}
                          min={TAKE_VOLUME_PRESET_MIN_DB}
                          max={TAKE_VOLUME_PRESET_MAX_DB}
                          value={mixerTakePresetsDb.song.aDb}
                          onChange={(event) => updateChannelTakePresetDb('song', 'a', Number(event.target.value))}
                          className='w-full rounded border border-sky-800/50 bg-zinc-900 px-1 py-1 text-center text-[10px] text-sky-200 outline-none focus:border-sky-400'
                        />
                      </label>
                      <label className='text-[10px] font-mono text-amber-300'>
                        <span className='mb-1 block text-center'>B</span>
                        <input
                          type='number'
                          step={0.1}
                          min={TAKE_VOLUME_PRESET_MIN_DB}
                          max={TAKE_VOLUME_PRESET_MAX_DB}
                          value={mixerTakePresetsDb.song.bDb}
                          onChange={(event) => updateChannelTakePresetDb('song', 'b', Number(event.target.value))}
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
                            className='w-full bg-gradient-to-t from-emerald-500 via-amber-400 to-rose-500 transition-[height] duration-75 ease-linear'
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
                            className='pointer-events-none absolute left-1/2 w-8 -translate-x-1/2 border-t border-amber-300/90'
                            style={{ bottom: `${Math.round(songPresetBFader * 100)}%` }}
                          />
                          <span
                            className='pointer-events-none absolute -right-3 text-[8px] font-bold text-amber-300'
                            style={{ bottom: `calc(${Math.round(songPresetBFader * 100)}% - 6px)` }}
                          >
                            B
                          </span>
                          {/* Fader Track Line */}
                          <div className='absolute left-1/2 top-0 h-full w-1.5 -translate-x-1/2 rounded-full bg-black shadow-[inset_0_1px_2px_rgba(255,255,255,0.1)]' />
                          {/* Wrapper for rotation */}
                          <div className='absolute top-1/2 left-1/2 flex items-center justify-center -translate-x-1/2 -translate-y-1/2 -rotate-90 w-64 h-10'>
                            <input
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
                      <input
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
                    <button
                      type='button'
                      onClick={() => triggerChannelTake('song')}
                      disabled={isApplyingTakePresetByChannel.song}
                      className='mt-2 w-4/5 rounded border border-sky-800/50 bg-zinc-900 py-1 text-[10px] font-bold tracking-wider text-sky-300 transition hover:bg-sky-900/20 disabled:opacity-50'
                    >
                      TAKE {songTakeTargetSide.toUpperCase()}
                    </button>
                  </div>

                  {shouldShowStreamStrip ? (
                    <>
                      {/* --- STREAM STRIP --- */}
                      <div className='flex w-36 flex-col items-center rounded-lg border border-cyan-900/50 bg-zinc-800/80 pb-6 shadow-xl'>
                        <div className='w-full rounded-t-lg border-b border-cyan-900/60 bg-cyan-950/20 py-2.5 text-center shadow-sm'>
                          <span className='text-[11px] font-bold tracking-widest text-cyan-300'>STREAM</span>
                        </div>

                        <div className='mt-5 flex w-full flex-col gap-2.5 px-5'>
                          <button
                            type='button'
                            onClick={toggleStreamMuted}
                            className={`flex h-9 w-full items-center justify-center rounded transition-all font-bold text-[11px] uppercase tracking-wider ${
                              mixerLevels.streamMuted
                                ? 'bg-red-600 text-white shadow-[0_0_12px_rgba(220,38,38,0.5)]'
                                : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-700 border border-zinc-700/50'
                            }`}
                          >
                            Mute
                          </button>
                          <button
                            type='button'
                            onClick={toggleStreamSolo}
                            className={`flex h-9 w-full items-center justify-center rounded transition-all font-bold text-[11px] uppercase tracking-wider ${
                              mixerLevels.streamSolo
                                ? 'bg-yellow-500 text-yellow-950 shadow-[0_0_12px_rgba(234,179,8,0.4)]'
                                : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-700 border border-zinc-700/50'
                            }`}
                          >
                            Solo
                          </button>
                        </div>
                        <div className='mt-2 grid w-full grid-cols-2 gap-2 px-5'>
                          <label className='text-[10px] font-mono text-sky-300'>
                            <span className='mb-1 block text-center'>A</span>
                            <input
                              type='number'
                              step={0.1}
                              min={TAKE_VOLUME_PRESET_MIN_DB}
                              max={TAKE_VOLUME_PRESET_MAX_DB}
                              value={mixerTakePresetsDb.stream.aDb}
                              onChange={(event) => updateChannelTakePresetDb('stream', 'a', Number(event.target.value))}
                              className='w-full rounded border border-sky-800/50 bg-zinc-900 px-1 py-1 text-center text-[10px] text-sky-200 outline-none focus:border-sky-400'
                            />
                          </label>
                          <label className='text-[10px] font-mono text-amber-300'>
                            <span className='mb-1 block text-center'>B</span>
                            <input
                              type='number'
                              step={0.1}
                              min={TAKE_VOLUME_PRESET_MIN_DB}
                              max={TAKE_VOLUME_PRESET_MAX_DB}
                              value={mixerTakePresetsDb.stream.bDb}
                              onChange={(event) => updateChannelTakePresetDb('stream', 'b', Number(event.target.value))}
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
                                className='pointer-events-none absolute left-1/2 w-8 -translate-x-1/2 border-t border-amber-300/90'
                                style={{ bottom: `${Math.round(streamPresetBFader * 100)}%` }}
                              />
                              <span
                                className='pointer-events-none absolute -right-3 text-[8px] font-bold text-amber-300'
                                style={{ bottom: `calc(${Math.round(streamPresetBFader * 100)}% - 6px)` }}
                              >
                                B
                              </span>
                              <div className='absolute left-1/2 top-0 h-full w-1.5 -translate-x-1/2 rounded-full bg-black shadow-[inset_0_1px_2px_rgba(255,255,255,0.1)]' />
                              <div className='absolute top-1/2 left-1/2 flex items-center justify-center -translate-x-1/2 -translate-y-1/2 -rotate-90 w-64 h-10'>
                                <input
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
                          <input
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
                            className='w-full bg-transparent px-2 text-center font-mono text-sm font-bold text-cyan-300 outline-none'
                          />
                          <span className='font-mono text-[9px] tracking-wider text-cyan-700'>{streamOutputGain > 0 ? 'LIVE' : 'CUT'}</span>
                        </div>
                        <button
                          type='button'
                          onClick={() => triggerChannelTake('stream')}
                          disabled={isApplyingTakePresetByChannel.stream}
                          className='mt-2 w-4/5 rounded border border-cyan-800/50 bg-zinc-900 py-1 text-[10px] font-bold tracking-wider text-cyan-300 transition hover:bg-cyan-900/20 disabled:opacity-50'
                        >
                          TAKE {streamTakeTargetSide.toUpperCase()}
                        </button>
                      </div>
                    </>
                  ) : null}

                  {/* --- INSTANTS STRIP --- */}
                  <div className='flex w-36 flex-col items-center rounded-lg border border-zinc-700 bg-zinc-800/80 pb-6 shadow-xl'>
                    <div className='w-full rounded-t-lg border-b border-zinc-700 bg-zinc-900 py-2.5 text-center shadow-sm'>
                      <span className='text-[11px] font-bold tracking-widest text-zinc-400'>INSTANTS</span>
                    </div>

                    <div className='mt-5 flex w-full flex-col gap-2.5 px-5'>
                      <button
                        type='button'
                        onClick={toggleInstantMuted}
                        className={`flex h-9 w-full items-center justify-center rounded transition-all font-bold text-[11px] uppercase tracking-wider ${
                          mixerLevels.instantMuted
                            ? 'bg-red-600 text-white shadow-[0_0_12px_rgba(220,38,38,0.5)]'
                            : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-700 border border-zinc-700/50'
                        }`}
                      >
                        Mute
                      </button>
                      <button
                        type='button'
                        onClick={toggleInstantSolo}
                        className={`flex h-9 w-full items-center justify-center rounded transition-all font-bold text-[11px] uppercase tracking-wider ${
                          mixerLevels.instantSolo
                            ? 'bg-yellow-500 text-yellow-950 shadow-[0_0_12px_rgba(234,179,8,0.4)]'
                            : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-700 border border-zinc-700/50'
                        }`}
                      >
                        Solo
                      </button>
                    </div>
                    <div className='mt-2 grid w-full grid-cols-2 gap-2 px-5'>
                      <label className='text-[10px] font-mono text-sky-300'>
                        <span className='mb-1 block text-center'>A</span>
                        <input
                          type='number'
                          step={0.1}
                          min={TAKE_VOLUME_PRESET_MIN_DB}
                          max={TAKE_VOLUME_PRESET_MAX_DB}
                          value={mixerTakePresetsDb.instants.aDb}
                          onChange={(event) => updateChannelTakePresetDb('instants', 'a', Number(event.target.value))}
                          className='w-full rounded border border-sky-800/50 bg-zinc-900 px-1 py-1 text-center text-[10px] text-sky-200 outline-none focus:border-sky-400'
                        />
                      </label>
                      <label className='text-[10px] font-mono text-amber-300'>
                        <span className='mb-1 block text-center'>B</span>
                        <input
                          type='number'
                          step={0.1}
                          min={TAKE_VOLUME_PRESET_MIN_DB}
                          max={TAKE_VOLUME_PRESET_MAX_DB}
                          value={mixerTakePresetsDb.instants.bDb}
                          onChange={(event) => updateChannelTakePresetDb('instants', 'b', Number(event.target.value))}
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
                            className='w-full bg-gradient-to-t from-emerald-500 via-amber-400 to-rose-500 transition-[height] duration-75 ease-linear'
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
                            className='pointer-events-none absolute left-1/2 w-8 -translate-x-1/2 border-t border-amber-300/90'
                            style={{ bottom: `${Math.round(instantsPresetBFader * 100)}%` }}
                          />
                          <span
                            className='pointer-events-none absolute -right-3 text-[8px] font-bold text-amber-300'
                            style={{ bottom: `calc(${Math.round(instantsPresetBFader * 100)}% - 6px)` }}
                          >
                            B
                          </span>
                          {/* Fader Track Line */}
                          <div className='absolute left-1/2 top-0 h-full w-1.5 -translate-x-1/2 rounded-full bg-black shadow-[inset_0_1px_2px_rgba(255,255,255,0.1)]' />
                          {/* Wrapper for rotation */}
                          <div className='absolute top-1/2 left-1/2 flex items-center justify-center -translate-x-1/2 -translate-y-1/2 -rotate-90 w-64 h-10'>
                            <input
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
                      <input
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
                    <button
                      type='button'
                      onClick={() => triggerChannelTake('instants')}
                      disabled={isApplyingTakePresetByChannel.instants}
                      className='mt-2 w-4/5 rounded border border-sky-800/50 bg-zinc-900 py-1 text-[10px] font-bold tracking-wider text-sky-300 transition hover:bg-sky-900/20 disabled:opacity-50'
                    >
                      TAKE {instantsTakeTargetSide.toUpperCase()}
                    </button>
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
                      <input
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
                        <input
                          type='number'
                          step={0.1}
                          min={TAKE_VOLUME_PRESET_MIN_DB}
                          max={TAKE_VOLUME_PRESET_MAX_DB}
                          value={mixerTakePresetsDb.main.aDb}
                          onChange={(event) => updateChannelTakePresetDb('main', 'a', Number(event.target.value))}
                          className='w-full rounded border border-sky-800/50 bg-zinc-900 px-1 py-1 text-center text-[10px] text-sky-200 outline-none focus:border-sky-400'
                        />
                      </label>
                      <label className='text-[10px] font-mono text-amber-300'>
                        <span className='mb-1 block text-center'>B</span>
                        <input
                          type='number'
                          step={0.1}
                          min={TAKE_VOLUME_PRESET_MIN_DB}
                          max={TAKE_VOLUME_PRESET_MAX_DB}
                          value={mixerTakePresetsDb.main.bDb}
                          onChange={(event) => updateChannelTakePresetDb('main', 'b', Number(event.target.value))}
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
                        className='pointer-events-none absolute left-1/2 w-8 -translate-x-1/2 border-t border-amber-300/90'
                        style={{ bottom: `${Math.round(mainPresetBFader * 100)}%` }}
                      />
                      <span
                        className='pointer-events-none absolute -right-3 text-[8px] font-bold text-amber-300'
                        style={{ bottom: `calc(${Math.round(mainPresetBFader * 100)}% - 6px)` }}
                      >
                        B
                      </span>
                      {/* Fader Track Line */}
                      <div className='absolute left-1/2 top-0 h-full w-2 -translate-x-1/2 rounded-full bg-black shadow-[inset_0_1px_2px_rgba(255,255,255,0.1)]' />
                      {/* Wrapper for rotation */}
                      <div className='absolute top-1/2 left-1/2 flex items-center justify-center -translate-x-1/2 -translate-y-1/2 -rotate-90 w-64 h-10'>
                        <input
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
                  <input
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
                    className='w-full bg-transparent px-2 text-center font-mono text-sm font-bold text-red-500 outline-none'
                  />
                  <span className='font-mono text-[9px] tracking-wider text-red-700'>{mainMixGain > 0 ? 'LIVE' : 'CUT'}</span>
                </div>
                <button
                  type='button'
                  onClick={() => triggerChannelTake('main')}
                  disabled={isApplyingTakePresetByChannel.main}
                  className='mt-2 w-4/5 rounded border border-red-900/50 bg-zinc-900 py-1 text-[10px] font-bold tracking-wider text-red-300 transition hover:bg-red-900/20 disabled:opacity-50'
                >
                  TAKE {mainTakeTargetSide.toUpperCase()}
                </button>
              </div>
            </div>

            <p className='text-xs text-text-secondary dark:text-text-secondary'>
              Solo follows mixer behavior: when any channel is soloed, non-soloed channels are cut. Main Mix applies after Song/Stream/Instants/Scene Instant.
              Instant channel still controls all catalog instants together, while Scene Instant controls only scene background instant playback.
            </p>
          </Card>

          {/* Instants Panel */}
          <Card className='space-y-4'>
            <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
              <h2 className='text-2xl font-semibold text-text-primary dark:text-text-primary'>Instants</h2>
              <div className='flex flex-wrap items-center gap-2'>
                <Button size='sm' variant='secondary' onClick={() => window.location.assign('/instants')}>
                  Manage Instants
                </Button>
                <Button size='sm' variant='secondary' onClick={() => void stopAllInstants()}>
                  Stop All
                </Button>
              </div>
            </div>
            <p className='flex items-center gap-2 text-xs text-text-secondary dark:text-text-secondary'>
              Hotkeys:
              <Kbd keys={['Ctrl', 'Q..M']} />
              <span>(QWERTY order, first 26 instants)</span>
            </p>
            {isLoadingInstants ? (
              <p className='text-sm text-text-secondary dark:text-text-secondary'>Loading instants...</p>
            ) : instants.length === 0 ? (
              <p className='text-sm text-text-secondary dark:text-text-secondary'>No instants in catalog. Create some in Instants.</p>
            ) : (
              <div className='overflow-x-auto'>
                <div className='grid grid-flow-col auto-cols-[120px] grid-rows-1 gap-3 pb-1'>
                  {instants.map((instant, index) => {
                    const playbackState = instantPlayback[instant.id] ?? null;
                    const isPlaying = playbackState !== null;
                    const durationMs = instantDurationsMs[instant.id] ?? null;
                    const shortcutLetter = getInstantShortcutLetter(index);

                    return (
                      <button
                        key={instant.id}
                        type='button'
                        onClick={() => {
                          void triggerInstant(instant.id);
                        }}
                        disabled={!instant.enabled}
                        className={`relative aspect-square min-h-[120px] rounded-xl border p-3 text-left transition-colors ${
                          !instant.enabled
                            ? 'cursor-not-allowed border-sand/20 bg-sand/10 opacity-60 dark:border-sand/40 dark:bg-sand/10'
                            : isPlaying
                              ? 'border-sea bg-sea/10 ring-2 ring-sea/20 dark:border-accent-blue dark:bg-accent-blue/10 dark:ring-accent-blue/20'
                              : 'border-sand/20 bg-white/80 hover:border-sea/40 dark:border-sand/40 dark:bg-dark-sand/60 dark:hover:border-accent-blue/50'
                        }`}
                        title={instant.name}
                      >
                        <span className='absolute left-2 top-2 inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-sea px-1 text-xs font-bold text-white dark:bg-accent-blue'>
                          {shortcutLetter || index + 1}
                        </span>
                        <div className='mt-6'>
                          <div className='line-clamp-2 text-sm font-semibold leading-tight text-text-primary dark:text-text-primary'>{instant.name}</div>
                          <div className='mt-1 line-clamp-1 text-xs text-text-secondary dark:text-text-secondary'>Vol {instant.volume}</div>
                          {isPlaying ? (
                            <div className='mt-1 line-clamp-1 text-[11px] font-semibold text-sea dark:text-accent-blue'>Playing</div>
                          ) : durationMs !== null ? (
                            <div className='mt-1 line-clamp-1 text-[11px] text-text-secondary dark:text-text-secondary'>
                              {`Length ${Math.max(0.1, durationMs / 1000).toFixed(1)}s`}
                            </div>
                          ) : null}
                        </div>
                        {isPlaying ? (
                          <div className='pointer-events-none absolute inset-0 overflow-hidden rounded-xl'>
                            {playbackState && playbackState.endsAtMs !== null ? (
                              <div
                                key={`${instant.id}-${playbackState.startedAtMs}`}
                                className='absolute inset-0 origin-left bg-sea dark:bg-accent-blue'
                                style={{
                                  animation: `${INSTANT_PLAYBACK_SWEEP_ANIMATION} ${Math.max(200, playbackState.endsAtMs - playbackState.startedAtMs)}ms linear forwards`
                                }}
                              />
                            ) : (
                              <div
                                className='absolute inset-0 bg-sea dark:bg-accent-blue'
                                style={{
                                  animation: `${INSTANT_PLAYBACK_PULSE_ANIMATION} 1400ms ease-in-out infinite`
                                }}
                              />
                            )}
                          </div>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </Card>

          {/* Scene Attributes Panel */}
          <Card className='space-y-4'>
            <h2 className='text-2xl font-semibold text-text-primary dark:text-text-primary'>Edit Staged Scene Attributes</h2>
            {!selectedScene ? (
              <p className='text-sm text-text-secondary dark:text-text-secondary'>Stage a scene above to edit its attributes before taking it live.</p>
            ) : (
              <div className='space-y-4'>
                <p className='text-sm text-sea dark:text-accent-blue'>
                  Editing staged scene: {scenes.find((s) => s.id === selectedScene)?.name}
                  {stagedIsOnAir ? ' (ON AIR)' : ''}
                </p>
                {activeProgramId === 'fifthbell' && (
                  <p className='text-xs text-text-secondary dark:text-text-secondary'>
                    FifthBell runtime settings are stored per component metadata (`fifthbell-content`, `fifthbell-marquee`, `fifthbell-clock` / `toni-clock`).
                  </p>
                )}
                <div className='space-y-3 rounded-xl border border-sand/20 p-4 dark:border-sand/40'>
                  <div className='flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between'>
                    <div className='flex-1'>
                      <label className='block text-xs text-gray-600 mb-1'>Scene Background Instant</label>
                      <select
                        value={selectedSceneInstantId ? String(selectedSceneInstantId) : ''}
                        onChange={(event) => {
                          const nextInstantId = normalizeSceneInstantId(event.target.value);
                          updateSceneEditorProp('sceneInstant', 'instantId', nextInstantId);
                        }}
                        className='w-full rounded border border-slate-300 px-3 py-2 text-sm focus:ring-2 focus:ring-green-500'
                      >
                        <option value=''>No background instant</option>
                        {instants
                          .filter((instant) => instant.enabled)
                          .map((instant) => (
                            <option key={instant.id} value={instant.id}>
                              {instant.name}
                            </option>
                          ))}
                      </select>
                    </div>
                    <div className='flex flex-wrap gap-2'>
                      <Button
                        size='sm'
                        onClick={() => {
                          void takeSceneInstant(selectedScene);
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
                        : 'Select an instant (changes save automatically), then TAKE BG.'}
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
                      </div>
                    );
                  })}
                </div>
                {isSavingSceneAttributes ? (
                  <p className='text-xs text-text-secondary dark:text-text-secondary text-right'>Autosaving scene attributes…</p>
                ) : null}
              </div>
            )}
          </Card>
        </div>
      </div>
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
            <label className='block text-xs text-gray-600 mb-1'>Hashtag</label>
            <input
              type='text'
              value={props.hashtag || ''}
              onChange={(e) => updateProp(componentType, 'hashtag', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='#Hashtag'
            />
          </div>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>URL</label>
            <input
              type='text'
              value={props.url || ''}
              onChange={(e) => updateProp(componentType, 'url', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='website.com'
            />
          </div>
        </div>
      );
    case 'chyron':
      return (
        <div className='space-y-2'>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>Text</label>
            <input
              type='text'
              value={props.text || ''}
              onChange={(e) => updateProp(componentType, 'text', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='Chyron message'
            />
          </div>
        </div>
      );
    case 'header':
      return (
        <div className='grid grid-cols-2 gap-3'>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>Title</label>
            <input
              type='text'
              value={props.title || ''}
              onChange={(e) => updateProp(componentType, 'title', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='Program title'
            />
          </div>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>Date</label>
            <input
              type='text'
              value={props.date || ''}
              onChange={(e) => updateProp(componentType, 'date', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
            />
          </div>
        </div>
      );
    case 'live-indicator':
      return (
        <div>
          <p className='text-xs text-gray-500 italic'>No configurable attributes. This component renders its SVG indicator.</p>
        </div>
      );
    case 'logo-widget':
      return (
        <div>
          <p className='text-xs text-gray-500 italic'>No configurable attributes. This component renders its SVG logo.</p>
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
            <label className='block text-xs text-gray-600 mb-1'>Source URL</label>
            <input
              type='text'
              value={props.sourceUrl || ''}
              onChange={(e) => updateProp(componentType, 'sourceUrl', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='https://example.com/stream.m3u8'
            />
          </div>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>Poster URL (optional)</label>
            <input
              type='text'
              value={props.posterUrl || ''}
              onChange={(e) => updateProp(componentType, 'posterUrl', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='https://example.com/poster.jpg'
            />
          </div>
          <div className='grid grid-cols-2 gap-3'>
            <label className='text-sm text-gray-700'>
              <span className='block text-xs text-gray-500 mb-1'>Fit Mode</span>
              <select
                value={props.objectFit || 'cover'}
                onChange={(e) => updateProp(componentType, 'objectFit', e.target.value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              >
                <option value='cover'>Cover</option>
                <option value='contain'>Contain</option>
              </select>
            </label>
          </div>
          <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
            <label className='flex items-center gap-2 text-sm text-gray-700'>
              <input
                type='checkbox'
                checked={toBoolean(props.autoPlay, true)}
                onChange={(e) => updateProp(componentType, 'autoPlay', e.target.checked)}
                className='h-4 w-4'
              />
              Autoplay
            </label>
            <label className='flex items-center gap-2 text-sm text-gray-700'>
              <input
                type='checkbox'
                checked={toBoolean(props.loop, false)}
                onChange={(e) => updateProp(componentType, 'loop', e.target.checked)}
                className='h-4 w-4'
              />
              Loop
            </label>
            <label className='flex items-center gap-2 text-sm text-gray-700'>
              <input
                type='checkbox'
                checked={toBoolean(props.showControls, false)}
                onChange={(e) => updateProp(componentType, 'showControls', e.target.checked)}
                className='h-4 w-4'
              />
              Show Native Controls
            </label>
          </div>
          <p className='text-xs text-gray-500'>Audio is controlled by mixer Song + Main faders (including mute/solo behavior).</p>
        </div>
      );
    case 'qr-code':
      return (
        <div>
          <label className='block text-xs text-gray-600 mb-1'>QR Code Content (URL or text)</label>
          <input
            type='text'
            value={props.content || ''}
            onChange={(e) => updateProp(componentType, 'content', e.target.value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
            placeholder='https://example.com'
          />
          <p className='text-xs text-gray-500 mt-1'>Enter URL or text to encode in QR code</p>
        </div>
      );
    case 'broadcast-layout':
      return (
        <div className='grid grid-cols-2 gap-3'>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>Header Title</label>
            <input
              type='text'
              value={props.headerTitle || ''}
              onChange={(e) => updateProp(componentType, 'headerTitle', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='Program title'
            />
          </div>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>Hashtag</label>
            <input
              type='text'
              value={props.hashtag || ''}
              onChange={(e) => updateProp(componentType, 'hashtag', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
            />
          </div>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>URL</label>
            <input
              type='text'
              value={props.url || ''}
              onChange={(e) => updateProp(componentType, 'url', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
            />
          </div>
          <div className='col-span-2'>
            <label className='block text-xs text-gray-600 mb-1'>Chyron Text</label>
            <input
              type='text'
              value={props.chyronText || ''}
              onChange={(e) => updateProp(componentType, 'chyronText', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='Optional lower chyron text'
            />
          </div>
          <div className='col-span-2'>
            <label className='flex items-center gap-2 text-sm text-gray-700'>
              <input
                type='checkbox'
                checked={toBoolean(props.showChyron, false)}
                onChange={(e) => updateProp(componentType, 'showChyron', e.target.checked)}
                className='h-4 w-4'
              />
              Show Chyron
            </label>
          </div>
          <div className='col-span-2'>
            <label className='block text-xs text-gray-600 mb-1'>QR Code Content</label>
            <input
              type='text'
              value={props.qrCodeContent || ''}
              onChange={(e) => updateProp(componentType, 'qrCodeContent', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='https://example.com'
            />
          </div>
          <div className='col-span-2'>
            <label className='block text-xs text-gray-600 mb-1'>Clock Timezone</label>
            <select
              value={props.clockTimezone || 'America/Argentina/Buenos_Aires'}
              onChange={(e) => updateProp(componentType, 'clockTimezone', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
            >
              {timezoneOptions.map((timezoneOption) => (
                <option key={timezoneOption.value} value={timezoneOption.value}>
                  {timezoneOption.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      );
    case 'clock-widget':
      return (
        <div>
          <label className='block text-xs text-gray-600 mb-1'>Timezone</label>
          <select
            value={props.timezone || 'America/Argentina/Buenos_Aires'}
            onChange={(e) => updateProp(componentType, 'timezone', e.target.value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
          >
            {timezoneOptions.map((timezoneOption) => (
              <option key={timezoneOption.value} value={timezoneOption.value}>
                {timezoneOption.label}
              </option>
            ))}
          </select>
        </div>
      );
    case 'reloj-clock':
      return (
        <div>
          <label className='block text-xs text-gray-600 mb-1'>Timezone</label>
          <select
            value={props.timezone || 'America/Argentina/Buenos_Aires'}
            onChange={(e) => updateProp(componentType, 'timezone', e.target.value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
          >
            {timezoneOptions.map((timezoneOption) => (
              <option key={timezoneOption.value} value={timezoneOption.value}>
                {timezoneOption.label}
              </option>
            ))}
          </select>
        </div>
      );
    case 'reloj-loop-clock':
      return (
        <div className='space-y-2'>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>Starting Timezone</label>
            <select
              value={props.timezone || 'Europe/Madrid'}
              onChange={(e) => updateProp(componentType, 'timezone', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
            >
              {timezoneOptions.map((timezoneOption) => (
                <option key={timezoneOption.value} value={timezoneOption.value}>
                  {timezoneOption.label}
                </option>
              ))}
            </select>
          </div>
          <p className='text-xs text-gray-500'>Loop sequence: Madrid, Sanremo, New York, Santiago. Each timezone stays active for 30 seconds.</p>
        </div>
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
            <label className='flex items-center gap-2 text-sm text-gray-700'>
              <input
                type='checkbox'
                checked={toBoolean(props.showWorldClocks, true)}
                onChange={(e) => updateProp(componentType, 'showWorldClocks', e.target.checked)}
                className='h-4 w-4'
              />
              Show World Clocks
            </label>
            {canToggleBellIcon ? (
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
                  type='checkbox'
                  checked={toBoolean(props.showBellIcon, false)}
                  onChange={(e) => updateProp(componentType, 'showBellIcon', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Bell Icon
              </label>
            ) : (
              <div className='text-sm text-gray-600'>FifthBell clock icon is always enabled.</div>
            )}
            <label className='flex items-center gap-2 text-sm text-gray-700'>
              <input
                type='checkbox'
                checked={toBoolean(props.worldClockShuffle, false)}
                onChange={(e) => updateProp(componentType, 'worldClockShuffle', e.target.checked)}
                className='h-4 w-4'
              />
              Shuffle world clocks
            </label>
          </div>

          <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'>
            <label className='text-sm text-gray-700'>
              <span className='block text-xs text-gray-500 mb-1'>World clock rotate (ms)</span>
              <input
                type='number'
                min={500}
                value={props.worldClockRotateIntervalMs ?? 5000}
                onChange={(e) => updateProp(componentType, 'worldClockRotateIntervalMs', Number(e.target.value))}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              />
            </label>
            <label className='text-sm text-gray-700'>
              <span className='block text-xs text-gray-500 mb-1'>World clock transition (ms)</span>
              <input
                type='number'
                min={0}
                value={props.worldClockTransitionMs ?? 300}
                onChange={(e) => updateProp(componentType, 'worldClockTransitionMs', Number(e.target.value))}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              />
            </label>
            <label className='text-sm text-gray-700'>
              <span className='block text-xs text-gray-500 mb-1'>World clock width (px)</span>
              <input
                type='number'
                min={120}
                value={props.worldClockWidthPx ?? 200}
                onChange={(e) => updateProp(componentType, 'worldClockWidthPx', Number(e.target.value))}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              />
            </label>
          </div>

          <div className='space-y-2'>
            <label className='block text-xs text-gray-600'>World Clock Cities JSON</label>
            <textarea
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
              className='w-full px-3 py-2 text-sm border rounded font-mono focus:ring-2 focus:ring-green-500'
            />
            <p className='text-xs text-gray-500'>Each item must be {'{ \"city\": \"SANREMO\", \"timezone\": \"Europe/Rome\" }'}.</p>
          </div>
        </div>
      );
    }
    case 'modoitaliano-disclaimer':
      return (
        <div className='space-y-3'>
          <p className='text-xs text-gray-500'>Shown only when ModoItaliano chyron is hidden/empty.</p>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>Text</label>
            <input
              type='text'
              value={props.text || ''}
              onChange={(e) => updateProp(componentType, 'text', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='Disclaimer text'
            />
          </div>
          <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3'>
            <label className='flex items-center gap-2 text-sm text-gray-700'>
              <input
                type='checkbox'
                checked={toBoolean(props.show, true)}
                onChange={(e) => updateProp(componentType, 'show', e.target.checked)}
                className='h-4 w-4'
              />
              Show Disclaimer
            </label>
            <label className='text-sm text-gray-700'>
              <span className='block text-xs text-gray-500 mb-1'>Alignment</span>
              <select
                value={props.align || 'right'}
                onChange={(e) => updateProp(componentType, 'align', e.target.value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              >
                <option value='left'>Left</option>
                <option value='center'>Center</option>
                <option value='right'>Right</option>
              </select>
            </label>
            <label className='text-sm text-gray-700'>
              <span className='block text-xs text-gray-500 mb-1'>Bottom (px)</span>
              <input
                type='number'
                min={0}
                value={props.bottomPx ?? 24}
                onChange={(e) => updateProp(componentType, 'bottomPx', Number(e.target.value))}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              />
            </label>
            <label className='text-sm text-gray-700'>
              <span className='block text-xs text-gray-500 mb-1'>Font Size (px)</span>
              <input
                type='number'
                min={10}
                value={props.fontSizePx ?? 20}
                onChange={(e) => updateProp(componentType, 'fontSizePx', Number(e.target.value))}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              />
            </label>
          </div>
          <label className='text-sm text-gray-700 block max-w-xs'>
            <span className='block text-xs text-gray-500 mb-1'>Opacity (0-1)</span>
            <input
              type='number'
              min={0}
              max={1}
              step={0.05}
              value={props.opacity ?? 0.82}
              onChange={(e) => updateProp(componentType, 'opacity', Number(e.target.value))}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
            />
          </label>
        </div>
      );
    case 'cronica-background':
      return <p className='text-xs text-gray-500 italic'>No configurable fields for Cronica background.</p>;
    case 'cronica-chyron':
      return (
        <div className='space-y-3'>
          <label className='block text-sm text-gray-700'>
            Text (Multi-line supported)
            <textarea
              value={props.text || ''}
              onChange={(e) => updateProp(componentType, 'text', e.target.value)}
              className='mt-1 w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500 h-24'
              placeholder='Enter chyron text...'
            />
          </label>
        </div>
      );
    case 'cronica-reiteramos':
      return (
        <div className='space-y-3'>
          <label className='block text-sm text-gray-700'>
            Text
            <input
              type='text'
              value={props.text || 'REITERAMOS'}
              onChange={(e) => updateProp(componentType, 'text', e.target.value)}
              className='mt-1 w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
            />
          </label>
          <label className='flex items-center gap-2 text-sm text-gray-700'>
            <input
              type='checkbox'
              checked={toBoolean(props.show, true)}
              onChange={(e) => updateProp(componentType, 'show', e.target.checked)}
              className='h-4 w-4 text-green-600 focus:ring-green-500 border-gray-300 rounded'
            />
            Show banner
          </label>
        </div>
      );
    case 'toni-logo':
      return <p className='text-xs text-gray-500 italic'>Logo cycles automatically between station images.</p>;
    case 'earone':
      return (
        <div className='space-y-2'>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>Label</label>
            <input
              type='text'
              value={props.label || 'EARONE'}
              onChange={(e) => updateProp(componentType, 'label', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='EARONE'
            />
          </div>
          <div className='grid grid-cols-2 gap-3'>
            <div>
              <label className='block text-xs text-gray-600 mb-1'>Rank</label>
              <input
                type='text'
                value={props.rank || ''}
                onChange={(e) => updateProp(componentType, 'rank', e.target.value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                placeholder='Uses active sequence item'
              />
            </div>
            <div>
              <label className='block text-xs text-gray-600 mb-1'>Spins Today</label>
              <input
                type='text'
                value={props.spins || ''}
                onChange={(e) => updateProp(componentType, 'spins', e.target.value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                placeholder='Uses active sequence item'
              />
            </div>
          </div>
          <p className='text-xs text-gray-500'>Leave rank/spins blank to follow the active Toni chyron sequence item.</p>
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
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
                  type='checkbox'
                  checked={toBoolean(props.showArticles, true)}
                  onChange={(e) => updateProp(componentType, 'showArticles', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Articles
              </label>
            )}
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
                  type='checkbox'
                  checked={toBoolean(props.showWeather, true)}
                  onChange={(e) => updateProp(componentType, 'showWeather', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Weather
              </label>
            )}
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
                  type='checkbox'
                  checked={toBoolean(props.showEarthquakes, true)}
                  onChange={(e) => updateProp(componentType, 'showEarthquakes', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Earthquakes
              </label>
            )}
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
                  type='checkbox'
                  checked={toBoolean(props.showMarkets, true)}
                  onChange={(e) => updateProp(componentType, 'showMarkets', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Markets
              </label>
            )}
            {supportsMarquee && (
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
                  type='checkbox'
                  checked={toBoolean(props.showMarquee, false)}
                  onChange={(e) => updateProp(componentType, 'showMarquee', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Bottom Marquee
              </label>
            )}
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
                  type='checkbox'
                  checked={toBoolean(props.showCallsignTake, true)}
                  onChange={(e) => updateProp(componentType, 'showCallsignTake', e.target.checked)}
                  className='h-4 w-4'
                />
                Enable Callsign Take
              </label>
            )}
            {supportsCorner && (
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
                  type='checkbox'
                  checked={toBoolean(props.showWorldClocks, true)}
                  onChange={(e) => updateProp(componentType, 'showWorldClocks', e.target.checked)}
                  className='h-4 w-4'
                />
                Show World Clocks
              </label>
            )}
            {supportsCorner && <div className='text-sm text-gray-600'>FifthBell clock icon is always enabled.</div>}
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
                  type='checkbox'
                  checked={toBoolean(props.audioCueEnabled, true)}
                  onChange={(e) => updateProp(componentType, 'audioCueEnabled', e.target.checked)}
                  className='h-4 w-4'
                />
                Enable Audio Cue
              </label>
            )}
            {supportsCorner && (
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
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
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Data load timeout (ms)</span>
                <input
                  type='number'
                  min={1000}
                  value={props.dataLoadTimeoutMs ?? 15000}
                  onChange={(e) => updateProp(componentType, 'dataLoadTimeoutMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Playlist default duration (ms)</span>
                <input
                  type='number'
                  min={1000}
                  value={props.playlistDefaultDurationMs ?? 10000}
                  onChange={(e) => updateProp(componentType, 'playlistDefaultDurationMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Playlist update interval (ms)</span>
                <input
                  type='number'
                  min={16}
                  value={props.playlistUpdateIntervalMs ?? 100}
                  onChange={(e) => updateProp(componentType, 'playlistUpdateIntervalMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Articles duration (ms)</span>
                <input
                  type='number'
                  min={1000}
                  value={props.articlesDurationMs ?? 10000}
                  onChange={(e) => updateProp(componentType, 'articlesDurationMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Weather duration (ms)</span>
                <input
                  type='number'
                  min={1000}
                  value={props.weatherDurationMs ?? 5000}
                  onChange={(e) => updateProp(componentType, 'weatherDurationMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Earthquakes duration (ms)</span>
                <input
                  type='number'
                  min={1000}
                  value={props.earthquakesDurationMs ?? 10000}
                  onChange={(e) => updateProp(componentType, 'earthquakesDurationMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Markets duration (ms)</span>
                <input
                  type='number'
                  min={1000}
                  value={props.marketsDurationMs ?? 10000}
                  onChange={(e) => updateProp(componentType, 'marketsDurationMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsCorner && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>World clock rotate (ms)</span>
                <input
                  type='number'
                  min={500}
                  value={props.worldClockRotateIntervalMs ?? 7000}
                  onChange={(e) => updateProp(componentType, 'worldClockRotateIntervalMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsCorner && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>World clock transition (ms)</span>
                <input
                  type='number'
                  min={0}
                  value={props.worldClockTransitionMs ?? 300}
                  onChange={(e) => updateProp(componentType, 'worldClockTransitionMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsCorner && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>World clock width (px)</span>
                <input
                  type='number'
                  min={120}
                  value={props.worldClockWidthPx ?? 200}
                  onChange={(e) => updateProp(componentType, 'worldClockWidthPx', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Audio cue minute</span>
                <input
                  type='number'
                  min={0}
                  max={59}
                  value={props.audioCueMinute ?? 59}
                  onChange={(e) => updateProp(componentType, 'audioCueMinute', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Audio cue second</span>
                <input
                  type='number'
                  min={0}
                  max={59}
                  value={props.audioCueSecond ?? 55}
                  onChange={(e) => updateProp(componentType, 'audioCueSecond', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Callsign prelaunch until (NYC ISO)</span>
                <input
                  type='text'
                  value={props.callsignPrelaunchUntilNyc ?? '2026-01-02T21:30:00'}
                  onChange={(e) => updateProp(componentType, 'callsignPrelaunchUntilNyc', e.target.value)}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                  placeholder='2026-01-02T21:30:00'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Callsign window start sec (:59)</span>
                <input
                  type='number'
                  min={0}
                  max={59}
                  value={props.callsignWindowStartSecond ?? 50}
                  onChange={(e) => updateProp(componentType, 'callsignWindowStartSecond', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Callsign window end sec (:00)</span>
                <input
                  type='number'
                  min={0}
                  max={59}
                  value={props.callsignWindowEndSecond ?? 3}
                  onChange={(e) => updateProp(componentType, 'callsignWindowEndSecond', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsMarquee && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Marquee min posts</span>
                <input
                  type='number'
                  min={0}
                  value={props.marqueeMinPostsCount ?? 4}
                  onChange={(e) => updateProp(componentType, 'marqueeMinPostsCount', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsMarquee && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Marquee min average relevance</span>
                <input
                  type='number'
                  min={0}
                  value={props.marqueeMinAverageRelevance ?? 0}
                  onChange={(e) => updateProp(componentType, 'marqueeMinAverageRelevance', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsMarquee && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Marquee min median relevance</span>
                <input
                  type='number'
                  min={0}
                  value={props.marqueeMinMedianRelevance ?? 0}
                  onChange={(e) => updateProp(componentType, 'marqueeMinMedianRelevance', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsMarquee && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Marquee px/sec</span>
                <input
                  type='number'
                  min={10}
                  value={props.marqueePixelsPerSecond ?? 150}
                  onChange={(e) => updateProp(componentType, 'marqueePixelsPerSecond', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsMarquee && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Marquee min duration (sec)</span>
                <input
                  type='number'
                  min={1}
                  value={props.marqueeMinDurationSeconds ?? 10}
                  onChange={(e) => updateProp(componentType, 'marqueeMinDurationSeconds', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsMarquee && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Marquee height (px)</span>
                <input
                  type='number'
                  min={72}
                  value={props.marqueeHeightPx ?? 72}
                  onChange={(e) => updateProp(componentType, 'marqueeHeightPx', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
          </div>
          {supportsMarquee && <p className='text-xs text-gray-500'>Marquee thresholds are minimums. Set any of them to `0` to disable that specific filter.</p>}

          {supportsContent && (
            <div className='space-y-2'>
              <label className='block text-xs text-gray-600'>Language Rotation (comma-separated: en, es, it)</label>
              <input
                type='text'
                defaultValue={languageRotation.join(', ')}
                onBlur={(e) => {
                  const next = e.target.value
                    .split(',')
                    .map((lang) => lang.trim().toLowerCase())
                    .filter((lang) => ['en', 'es', 'it'].includes(lang));
                  updateProp(componentType, 'languageRotation', next.length > 0 ? next : ['en']);
                }}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              />
            </div>
          )}

          {supportsContent && (
            <div>
              <h3 className='text-sm font-semibold text-gray-800 mb-2'>Weather Cities</h3>
              <p className='text-xs text-gray-500 mb-2'>If none are selected, all cities are shown in the weather segment.</p>
              <div className='grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 max-h-64 overflow-auto border rounded p-3 bg-gray-50'>
                {FIFTHBELL_AVAILABLE_WEATHER_CITIES.map((city) => (
                  <label key={city} className='flex items-center gap-2 text-sm text-gray-700'>
                    <input
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
              <label className='block text-xs text-gray-600'>World Clock Cities JSON (optional override)</label>
              <textarea
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
                className='w-full px-3 py-2 text-sm border rounded font-mono focus:ring-2 focus:ring-green-500'
              />
              <p className='text-xs text-gray-500'>Each item must be {'{ \"city\": \"NEW YORK\", \"timezone\": \"America/New_York\" }'}.</p>
            </div>
          )}
        </div>
      );
    }
    default:
      return <div className='text-xs text-gray-500 italic'>Default configuration</div>;
  }
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
        <button
          type='button'
          onClick={() =>
            applyProps({
              ...props,
              contentMode: 'text'
            })
          }
          className={`px-3 py-1.5 rounded text-sm font-medium border ${
            contentMode === 'text' ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
          }`}
        >
          Direct Text
        </button>
        <button
          type='button'
          onClick={() =>
            applyProps({
              ...props,
              contentMode: 'sequence',
              sequence: normalizedSequence ?? createToniChyronSequence('manual')
            })
          }
          className={`px-3 py-1.5 rounded text-sm font-medium border ${
            contentMode === 'sequence' ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
          }`}
        >
          Sequence
        </button>
      </div>

      {contentMode === 'sequence' ? (
        <div className='space-y-3'>
          <p className='text-xs text-gray-500'>Sequence mode lets you preload multiple chyron values and take them live with one tap.</p>
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
          <details className='rounded border border-dashed border-gray-300 px-3 py-2'>
            <summary className='cursor-pointer text-xs font-medium text-gray-600'>Fallback direct text</summary>
            <div className='space-y-2 pt-3'>
              <div>
                <label className='block text-xs text-gray-600 mb-1'>Fallback Text</label>
                <input
                  type='text'
                  value={props.text || ''}
                  onChange={(e) => updateProp(componentType, 'text', e.target.value)}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                  placeholder='Used only if the sequence is empty'
                />
              </div>
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
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
            <label className='block text-xs text-gray-600 mb-1'>Text</label>
            <input
              type='text'
              value={props.text || ''}
              onChange={(e) => updateProp(componentType, 'text', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='Chyron message'
            />
          </div>
          <label className='flex items-center gap-2 text-sm text-gray-700'>
            <input
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
        <label className='block text-xs text-gray-600'>Social Handles (comma-separated)</label>
        <input
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
          className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
          placeholder='@modoitaliano.oficial, @fifth.bell, @hnmages'
        />
        <p className='text-xs text-gray-500'>Set an empty value to hide social handles.</p>
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
    <div className={`space-y-3 rounded border ${isNested ? 'border-slate-200 bg-slate-50/70' : 'border-slate-300 bg-slate-50'} p-3`}>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='text-xs font-semibold uppercase tracking-wide text-slate-600'>{isNested ? 'Nested Sequence' : 'Sequence'}</span>
        <button
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
            sequence.mode === 'manual' ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
          }`}
        >
          Manual
        </button>
        <button
          type='button'
          onClick={() => {
            void applySequenceAndTakeSelection({
              ...sequence,
              mode: 'autoplay',
              startedAt: Date.now()
            });
          }}
          className={`px-2.5 py-1 rounded text-xs font-medium border ${
            sequence.mode === 'autoplay' ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
          }`}
        >
          Autoplay
        </button>
        {sequence.mode === 'autoplay' && (
          <>
            <label className='text-xs text-slate-600'>Interval (ms)</label>
            <input
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
              className='w-28 px-2 py-1 text-xs border rounded focus:ring-2 focus:ring-green-500'
            />
            <label className='flex items-center gap-1 text-xs text-slate-600'>
              <input
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

      {sequence.items.length === 0 && <p className='text-xs text-slate-500'>This sequence is empty. Add items below.</p>}

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
              className={`rounded border p-3 ${isActive ? 'border-green-300 bg-green-50' : 'border-slate-200 bg-white'}`}
            >
              <div className='flex flex-wrap items-center gap-2'>
                <span
                  draggable
                  onDragStart={() => setDraggingIndex(index)}
                  onDragEnd={() => setDraggingIndex(null)}
                  className='cursor-grab select-none rounded border border-dashed border-slate-300 p-2 text-slate-500'
                  title='Drag to reorder'
                  aria-label='Drag to reorder'
                >
                  <GripVertical size={14} strokeWidth={2} />
                </span>
                <div className='min-w-0 flex-1 text-xs font-medium uppercase tracking-wide text-slate-500'>
                  {displayItem.kind === 'sequence' ? 'Nested Sequence' : 'Sequence Item'}
                </div>
                <button
                  type='button'
                  onClick={() => {
                    void activateItem(displayItem.id);
                  }}
                  className='px-3 py-2 text-xs font-semibold rounded bg-green-600 text-white hover:bg-green-700'
                >
                  Take
                </button>
                <button
                  type='button'
                  onClick={() => removeItem(index)}
                  className='px-3 py-2 text-xs font-semibold rounded border border-red-200 text-red-600 hover:bg-red-50'
                >
                  Remove
                </button>
              </div>

              {displayItem.kind === 'preset' ? (
                <div className='mt-3 space-y-2'>
                  <div>
                    <label className='block text-xs text-gray-600 mb-1'>Text</label>
                    <input
                      type='text'
                      value={displayItem.text}
                      onChange={(e) =>
                        updateItem(index, {
                          ...displayItem,
                          text: e.target.value
                        })
                      }
                      className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                      placeholder='Chyron message'
                    />
                  </div>
                  <div className='grid grid-cols-2 gap-3'>
                    <div className='col-span-2'>
                      <label className='block text-xs text-gray-600 mb-1'>EarOne Song ID</label>
                      <input
                        type='text'
                        value={displayItem.earoneSongId || ''}
                        onChange={(e) =>
                          updateItem(index, {
                            ...displayItem,
                            earoneSongId: e.target.value
                          })
                        }
                        className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                        placeholder='Matches against song.earoneSongId'
                      />
                    </div>
                    <div>
                      <label className='block text-xs text-gray-600 mb-1'>Earone Rank</label>
                      <input
                        type='text'
                        value={displayItem.earoneRank || ''}
                        onChange={(e) =>
                          updateItem(index, {
                            ...displayItem,
                            earoneRank: e.target.value
                          })
                        }
                        className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                        placeholder='e.g. 4'
                      />
                    </div>
                    <div>
                      <label className='block text-xs text-gray-600 mb-1'>Earone Spins</label>
                      <input
                        type='text'
                        value={displayItem.earoneSpins || ''}
                        onChange={(e) =>
                          updateItem(index, {
                            ...displayItem,
                            earoneSpins: e.target.value
                          })
                        }
                        className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                        placeholder='e.g. 124'
                      />
                    </div>
                  </div>
                  <label className='flex items-center gap-2 text-sm text-gray-700'>
                    <input
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
        <button type='button' onClick={addItem} className='px-3 py-2 text-xs font-semibold rounded border border-slate-300 text-slate-700 hover:bg-slate-100'>
          + Sequence
        </button>
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
      <p className='text-xs text-gray-500'>ModoItaliano row rule: if chyron and disclaimer are both enabled, chyron is shown.</p>
      <Switch checked={showValue} onCheckedChange={(checked) => updateProp(componentType, 'show', checked)} label='Show Chyron' />

      <div className='space-y-2 rounded border border-slate-200 p-3'>
        <span className='text-xs font-semibold uppercase tracking-wide text-slate-600'>Main Chyron</span>
        <div className='space-y-3'>
          <p className='text-xs text-gray-500'>Sequence-only. If no text item is selected, the chyron is hidden.</p>
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

      <div className='space-y-2 rounded border border-slate-200 p-3'>
        <span className='text-xs font-semibold uppercase tracking-wide text-slate-600'>CTA</span>
        <div className='space-y-3'>
          <p className='text-xs text-gray-500'>CTA is sequence-only as well.</p>
          <ProgramTextSequenceEditor
            sequence={ctaSequenceForEditor}
            textLabel='CTA'
            textPlaceholder='Call to action (shown above chyron)'
            onChange={(nextSequence) => applyProps(buildSequenceProps(textSequenceForEditor, nextSequence))}
            onTakeSelection={activateCtaSequence}
          />
        </div>
      </div>
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
    <div className={`space-y-3 rounded border ${isNested ? 'border-slate-200 bg-slate-50/70' : 'border-slate-300 bg-slate-50'} p-3`}>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='text-xs font-semibold uppercase tracking-wide text-slate-600'>{isNested ? 'Nested Sequence' : 'Sequence'}</span>
        <button
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
            sequence.mode === 'manual' ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
          }`}
        >
          Manual
        </button>
        <button
          type='button'
          onClick={() =>
            applySequence({
              ...sequence,
              mode: 'autoplay',
              startedAt: Date.now()
            })
          }
          className={`px-2.5 py-1 rounded text-xs font-medium border ${
            sequence.mode === 'autoplay' ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
          }`}
        >
          Autoplay
        </button>
        {sequence.mode === 'autoplay' && (
          <>
            <label className='text-xs text-slate-600'>Interval (ms)</label>
            <input
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
              className='w-28 px-2 py-1 text-xs border rounded focus:ring-2 focus:ring-green-500'
            />
            <label className='flex items-center gap-1 text-xs text-slate-600'>
              <input
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

      {sequence.items.length === 0 && <p className='text-xs text-slate-500'>This sequence is empty. Add items below.</p>}

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
              className={`rounded border p-3 ${isActive ? 'border-green-300 bg-green-50' : 'border-slate-200 bg-white'}`}
            >
              <div className='flex flex-wrap items-center gap-2'>
                <span
                  draggable
                  onDragStart={() => setDraggingIndex(index)}
                  onDragEnd={() => setDraggingIndex(null)}
                  className='cursor-grab select-none rounded border border-dashed border-slate-300 p-2 text-slate-500'
                  title='Drag to reorder'
                  aria-label='Drag to reorder'
                >
                  <GripVertical size={14} strokeWidth={2} />
                </span>
                <div className='min-w-0 flex-1 text-xs font-medium uppercase tracking-wide text-slate-500'>
                  {displayItem.kind === 'sequence' ? 'Nested Sequence' : 'Sequence Item'}
                </div>
                <button
                  type='button'
                  onClick={() => {
                    void activateItem(displayItem.id);
                  }}
                  className='px-3 py-2 text-xs font-semibold rounded bg-green-600 text-white hover:bg-green-700'
                >
                  Take
                </button>
                <button
                  type='button'
                  onClick={() => removeItem(index)}
                  className='px-3 py-2 text-xs font-semibold rounded border border-red-200 text-red-600 hover:bg-red-50'
                >
                  Remove
                </button>
              </div>

              {displayItem.kind === 'preset' ? (
                <div className='mt-3 space-y-2'>
                  <label className='text-sm text-gray-700 block'>
                    <span className='block text-xs text-gray-500 mb-1'>{textLabel}</span>
                    <input
                      type='text'
                      value={displayItem.text}
                      onChange={(e) =>
                        updateItem(index, {
                          ...displayItem,
                          text: e.target.value
                        })
                      }
                      className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                      placeholder={textPlaceholder}
                    />
                  </label>
                  {includeMarquee && (
                    <label className='flex items-center gap-2 text-sm text-gray-700'>
                      <input
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
        <button type='button' onClick={addItem} className='px-3 py-2 text-xs font-semibold rounded border border-slate-300 text-slate-700 hover:bg-slate-100'>
          + Sequence
        </button>
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
  depth = 0
}: {
  sequence: ProgramSongSequence;
  songCatalog?: SongCatalogItem[];
  programSongPlayback?: ProgramSongPlaybackState | null;
  onChange: (nextSequence: ProgramSongSequence) => void;
  onTakeSelection?: (nextSequence: ProgramSongSequence) => Promise<void> | void;
  onTakeOffAir?: () => Promise<void> | void;
  depth?: number;
}) {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const [addSongValue, setAddSongValue] = useState('');
  const songDurationByUrlRef = useRef<Record<string, number | null>>({});
  const autoTakeOffTimerRef = useRef<number | null>(null);
  const sequenceRef = useRef(sequence);
  const isNested = depth > 0;
  const effectiveActiveItemId = getProgramSongSequenceSelectedItemId(sequence, nowMs);
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
    if (!sequence.activeItemId) {
      return;
    }

    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 250);

    return () => clearInterval(timer);
  }, [sequence.activeItemId, sequence.startedAt]);

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
    const anchorActiveItemId = isAutoplay ? (effectiveActiveItemId ?? sequence.activeItemId ?? nextItem.id) : (sequence.activeItemId ?? nextItem.id);

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
      activeItemId: sequence.mode === 'autoplay' ? (effectiveActiveItemId ?? sequence.activeItemId ?? filledItem.id) : sequence.activeItemId
    });
  };

  const removeItem = (index: number) => {
    const removedItem = sequence.items[index];
    if (!removedItem) {
      return;
    }

    const nextItems = sequence.items.filter((_, itemIndex) => itemIndex !== index);
    const isAutoplay = sequence.mode === 'autoplay';
    const runtimeActiveItemId = isAutoplay ? (effectiveActiveItemId ?? sequence.activeItemId) : sequence.activeItemId;
    const removedCurrentRuntimeItem = runtimeActiveItemId !== null && runtimeActiveItemId === removedItem.id;
    let nextActiveItemId: string | null;

    if (nextItems.length === 0) {
      nextActiveItemId = null;
    } else if (removedCurrentRuntimeItem) {
      nextActiveItemId = nextItems[Math.min(index, nextItems.length - 1)]?.id ?? null;
    } else {
      nextActiveItemId = runtimeActiveItemId && nextItems.some((item) => item.id === runtimeActiveItemId) ? runtimeActiveItemId : (nextItems[0]?.id ?? null);
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

    const targetItemId = sequence.mode === 'autoplay' ? (effectiveActiveItemId ?? sequence.activeItemId ?? null) : (sequence.activeItemId ?? null);
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
    <div className={`flex flex-col overflow-hidden rounded-xl ${isNested ? 'border border-zinc-800 bg-zinc-900' : 'bg-zinc-950'}`}>
      {/* Two-column layout container */}
      <div className='flex flex-col md:flex-row'>
        {/* Left Column: Playlist Queue */}
        <div className='flex-1 border-r-0 border-zinc-800/60 md:border-r'>
          <div className='flex items-center justify-between border-b border-zinc-800/60 bg-zinc-900/20 px-4 py-2 border-t'>
            <span className='text-[10px] font-semibold uppercase tracking-widest text-zinc-500'>Current Queue</span>
            <span className='text-[10px] text-zinc-500'>
              {sequence.items.length} {sequence.items.length === 1 ? 'song' : 'songs'}
            </span>
          </div>

          {sequence.items.length === 0 ? (
            <div className='flex flex-col items-center justify-center px-4 py-16 text-center'>
              <Music2 size={32} className='mb-3 text-zinc-700' />
              <p className='text-sm font-medium text-zinc-400'>Queue is empty</p>
              <p className='mt-1 text-xs text-zinc-600'>Search and add songs from the catalog panel.</p>
            </div>
          ) : (
            <div className='overflow-x-auto'>
              <div className='min-w-100'>
                {/* Column header */}
                <div className='grid grid-cols-[28px_28px_1fr_52px_56px] items-center border-b border-zinc-800/60 px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest text-zinc-700'>
                  <span />
                  <span className='text-center'>#</span>
                  <span style={{ paddingLeft: '50px' }}>Title</span>
                  <span className='flex items-center justify-end pr-3'>
                    <Clock size={10} />
                  </span>
                  <span />
                </div>

                <div className='divide-y divide-zinc-800/40'>
                  {sequence.items.map((item, index) => {
                    const displayItem = item;
                    const isActive = displayItem.id === effectiveActiveItemId;
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
                            isActive ? 'bg-sky-500/10' : 'hover:bg-white/3'
                          }`}
                        >
                          {/* Drag handle — hidden until hover */}
                          <span
                            draggable
                            onDragStart={() => setDraggingIndex(index)}
                            onDragEnd={() => setDraggingIndex(null)}
                            className='inline-flex h-6 w-6 cursor-grab select-none items-center justify-center text-zinc-700 opacity-0 transition-opacity group-hover:opacity-100'
                            title='Drag to reorder'
                            aria-label='Drag to reorder'
                          >
                            <GripVertical size={12} strokeWidth={2} />
                          </span>

                          {/* Track number / eq bars / take-on-hover */}
                          <button
                            type='button'
                            onClick={() => {
                              void activateItem(displayItem.id);
                            }}
                            className='relative flex h-6 w-6 shrink-0 items-center justify-center'
                            title='Take on air'
                          >
                            {/* Number — visible by default when not active, hidden on hover */}
                            <span className={`text-xs tabular-nums transition-opacity ${isActive ? 'opacity-0' : 'text-zinc-500 group-hover:opacity-0'}`}>
                              {index + 1}
                            </span>
                            {/* EQ bars — only when active */}
                            {isActive && (
                              <span className='absolute inset-0 flex items-end justify-center gap-0.5 pb-0.5 group-hover:opacity-0'>
                                <span
                                  className='w-0.75 rounded-sm bg-sky-400 opacity-100'
                                  style={{ animation: 'eq-bar1 0.8s ease-in-out infinite alternate' }}
                                />
                                <span
                                  className='w-0.75 rounded-sm bg-sky-400 opacity-100'
                                  style={{ animation: 'eq-bar2 0.8s ease-in-out 0.15s infinite alternate' }}
                                />
                                <span
                                  className='w-0.75 rounded-sm bg-sky-400 opacity-100'
                                  style={{ animation: 'eq-bar1 0.8s ease-in-out 0.3s infinite alternate' }}
                                />
                              </span>
                            )}
                            {/* Play icon — shows on hover always */}
                            <span className='absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100'>
                              <Play size={11} className='fill-zinc-100 text-zinc-100' />
                            </span>
                          </button>

                          {/* Cover art + title + artist */}
                          <div className='flex min-w-0 items-center gap-2.5 pl-1'>
                            {coverUrl ? (
                              <img src={coverUrl} alt={`${artistText} - ${titleText}`} className='h-9 w-9 shrink-0 rounded-sm object-cover shadow-md' />
                            ) : (
                              <div className='flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-zinc-800 text-xs font-bold text-zinc-600'>
                                {titleText.slice(0, 1).toUpperCase() || '?'}
                              </div>
                            )}
                            <div className='min-w-0'>
                              <div className={`truncate text-[13px] font-medium leading-tight ${isActive ? 'text-sky-400' : 'text-zinc-100'}`}>{titleText}</div>
                              <div className='truncate text-[11px] leading-tight text-zinc-500 mt-0.5'>{artistText}</div>
                            </div>
                          </div>

                          {/* Duration */}
                          <span className={`text-right pr-3 text-xs tabular-nums ${isActive ? 'text-sky-400' : 'text-zinc-500'}`}>{rowDuration}</span>

                          {/* Hover actions */}
                          <div className='flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100'>
                            {displayItem.kind === 'preset' ? (
                              <button
                                type='button'
                                onClick={() => setExpandedItemId((prev) => (prev === displayItem.id ? null : displayItem.id))}
                                className='flex h-6 w-6 items-center justify-center rounded text-zinc-500 transition-colors hover:text-zinc-200'
                                title='Edit song'
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
                              </button>
                            ) : null}
                            <button
                              type='button'
                              onClick={() => removeItem(index)}
                              className='flex h-6 w-6 items-center justify-center rounded text-zinc-600 transition-colors hover:text-red-400'
                              title='Remove'
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
                            </button>
                          </div>
                        </div>

                        {/* Expanded edit panel */}
                        {displayItem.kind === 'preset' && isExpanded ? (
                          <div className='border-t border-zinc-800 bg-zinc-900/40 px-3 py-2'>
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
                          <div className='border-t border-zinc-800 bg-zinc-900/50 px-4 py-3'>
                            <p className='mb-2 text-xs text-zinc-600'>Legacy nested sequence. Flatten if possible.</p>
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

        {/* Right Column: Catalog Inventory */}
        <div className='hidden w-[320px] shrink-0 flex-col border-t border-zinc-800/60 bg-zinc-900/30 md:flex'>
          <div className='border-b border-zinc-800/60 bg-zinc-900/40 p-2'>
            <input
              type='text'
              placeholder='Search catalog to add...'
              value={addSongValue}
              onChange={(e) => setAddSongValue(e.target.value)}
              className='w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-sky-500/50 focus:outline-none focus:ring-1 focus:ring-sky-500/50'
            />
          </div>
          <div className='max-h-125 flex-1 overflow-y-auto'>
            {availableSongCatalog
              .filter((song) => {
                if (!addSongValue) return true;
                const search = addSongValue.toLowerCase();
                return song.title?.toLowerCase().includes(search) || song.artist?.toLowerCase().includes(search);
              })
              .slice(0, 80)
              .map((song) => (
                <div key={song.id} className='group flex items-center justify-between border-b border-zinc-800/40 px-3 py-2 hover:bg-white/5'>
                  <div className='flex min-w-0 items-center gap-2'>
                    {song.coverUrl ? (
                      <img src={song.coverUrl} alt='' className='h-8 w-8 shrink-0 rounded-sm object-cover opacity-80' />
                    ) : (
                      <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-zinc-800 text-zinc-500'>
                        {song.title?.charAt(0) || <Music2 size={12} />}
                      </div>
                    )}
                    <div className='min-w-0 pr-2'>
                      <div className='truncate text-[11px] font-medium text-zinc-200'>{song.title}</div>
                      <div className='truncate text-[10px] text-zinc-500'>{song.artist}</div>
                    </div>
                  </div>
                  <button
                    type='button'
                    onClick={() => addItemFromCatalog(song.id)}
                    className='flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-zinc-500 opacity-0 transition-all hover:bg-sky-500/20 hover:text-sky-400 group-hover:opacity-100'
                    title='Add to queue'
                  >
                    <Plus size={14} />
                  </button>
                </div>
              ))}
            {availableSongCatalog.length > 0 &&
              availableSongCatalog.filter(
                (song) =>
                  !addSongValue ||
                  song.title?.toLowerCase().includes(addSongValue.toLowerCase()) ||
                  song.artist?.toLowerCase().includes(addSongValue.toLowerCase())
              ).length === 0 && <div className='p-4 text-center text-xs text-zinc-500'>No matches found</div>}
          </div>
        </div>
      </div>

      {/* Playback Bar */}
      <div className='flex items-center justify-between border-t border-zinc-800 bg-zinc-900/80 px-4 py-3'>
        {/* Transport controls */}
        <div className='flex items-center gap-2'>
          <button
            type='button'
            title='Previous'
            disabled={sequence.items.findIndex((i) => i.id === effectiveActiveItemId) <= 0}
            onClick={() => {
              const idx = sequence.items.findIndex((i) => i.id === effectiveActiveItemId);
              if (idx > 0) {
                void activateItem(sequence.items[idx - 1].id);
              }
            }}
            className='flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 transition-colors hover:text-zinc-200 disabled:opacity-30'
          >
            <SkipBack size={16} fill='currentColor' />
          </button>

          <button
            type='button'
            title={sequence.activeItemId ? 'Next / Advance' : 'Play'}
            onClick={() => {
              if (!sequence.activeItemId && sequence.items.length > 0) {
                void activateItem(sequence.items[0].id);
              } else if (sequence.activeItemId) {
                const idx = sequence.items.findIndex((i) => i.id === sequence.activeItemId);
                if (idx < sequence.items.length - 1) {
                  void activateItem(sequence.items[idx + 1].id);
                } else {
                  void activateItem(sequence.items[0].id);
                }
              }
            }}
            className='flex h-10 w-10 items-center justify-center rounded-full bg-sky-500 text-zinc-950 shadow-lg transition-transform hover:scale-105 hover:bg-sky-400 active:scale-95'
          >
            <Play size={18} fill='currentColor' className='ml-0.5' />
          </button>

          <button
            type='button'
            title='Stop / Take Off Air'
            onClick={() => {
              void clearActiveItem();
            }}
            className='flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 transition-colors hover:text-zinc-200'
          >
            <Square size={16} fill='currentColor' />
          </button>

          <button
            type='button'
            title='Next'
            disabled={!effectiveActiveItemId || sequence.items.findIndex((i) => i.id === effectiveActiveItemId) >= sequence.items.length - 1}
            onClick={() => {
              const idx = sequence.items.findIndex((i) => i.id === effectiveActiveItemId);
              if (idx < sequence.items.length - 1) {
                void activateItem(sequence.items[idx + 1].id);
              }
            }}
            className='flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 transition-colors hover:text-zinc-200 disabled:opacity-30'
          >
            <SkipForward size={16} fill='currentColor' />
          </button>
        </div>

        {/* Now playing info + progress */}
        <div className='hidden min-w-0 flex-1 px-4 md:block'>
          {sequence.activeItemId ? (
            (() => {
              // In autoplay, effectiveActiveItemId walks the sequence by elapsed time
              const displayItem = sequence.items.find((i) => i.id === effectiveActiveItemId);
              if (!displayItem || displayItem.kind !== 'preset') return null;

              const displayAudioUrl = displayItem.audioUrl?.trim() || '';
              const playbackAudioUrl = programSongPlayback?.audioUrl?.trim() || '';
              const playbackToken = programSongPlayback?.token || '';
              const playbackMatchesDisplaySong =
                !isNested &&
                !!programSongPlayback &&
                ((displayAudioUrl && playbackAudioUrl && displayAudioUrl === playbackAudioUrl) ||
                  (displayItem.id && playbackToken.startsWith(`${displayItem.id}:`)) ||
                  (sequence.activeItemId === displayItem.id && programSongPlayback.isPlaying));

              // Compute how far into the current song we are
              let songElapsedMs = 0;
              let songStartedAt = typeof sequence.startedAt === 'number' ? sequence.startedAt : nowMs;

              if (playbackMatchesDisplaySong && programSongPlayback) {
                songElapsedMs = Math.max(0, programSongPlayback.currentTimeMs);
                songStartedAt = Math.max(0, nowMs - songElapsedMs);
              } else if (sequence.mode === 'autoplay' && typeof sequence.startedAt === 'number') {
                const seqStartedAt = sequence.startedAt;
                const totalElapsed = Math.max(0, nowMs - seqStartedAt);
                const baseIndex = sequence.items.findIndex((i) => i.id === sequence.activeItemId);
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
                playbackMatchesDisplaySong && programSongPlayback && typeof programSongPlayback.durationMs === 'number'
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
                <div className='relative overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/60'>
                  {/* Fill progress from direct playback ratio (avoids animation jitter). */}
                  {hasProgressTimeline && (
                    <div
                      className='pointer-events-none absolute inset-0 origin-left bg-sky-500/20'
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
                      <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-zinc-800'>
                        <Music2 size={11} className='text-zinc-500' />
                      </div>
                    )}
                    <div className='min-w-0 flex-1'>
                      <div className='truncate text-xs font-semibold text-sky-400'>{displayItem.title || ''}</div>
                      <div className='truncate text-[10px] text-zinc-400'>{displayItem.artist || ''}</div>
                    </div>
                    <div className='shrink-0 text-right text-[10px] tabular-nums text-zinc-500'>
                      {hasProgressTimeline && (
                        <span>
                          {fmt(clampedSongElapsedMs)}
                          <span className='text-zinc-700'> / {fmt(totalMs)}</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()
          ) : (
            <p className='text-[11px] text-zinc-600'>Nothing on air</p>
          )}
        </div>

        {/* Mode and loop toggles */}
        <div className='flex items-center gap-3'>
          <div className='flex items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-950/60 p-0.5'>
            <button
              type='button'
              onClick={() =>
                applySequence({
                  ...sequence,
                  mode: 'manual',
                  activeItemId: sequence.mode === 'autoplay' ? (effectiveActiveItemId ?? sequence.activeItemId) : sequence.activeItemId,
                  startedAt: Date.now()
                })
              }
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                sequence.mode === 'manual' ? 'bg-zinc-700 text-zinc-100 shadow-sm' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              Manual
            </button>
            <button
              type='button'
              onClick={() =>
                applySequence({
                  ...sequence,
                  mode: 'autoplay',
                  activeItemId: sequence.mode === 'autoplay' ? (effectiveActiveItemId ?? sequence.activeItemId) : sequence.activeItemId,
                  startedAt: resolveAutoplayStartedAt()
                })
              }
              className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                sequence.mode === 'autoplay' ? 'bg-sky-500/20 text-sky-400' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <Play size={9} fill='currentColor' />
              Autoplay
            </button>
          </div>

          <button
            type='button'
            title='Loop'
            onClick={() => applySequence({ ...sequence, loop: sequence.loop === false ? true : false })}
            className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
              sequence.loop !== false ? 'text-sky-400 bg-sky-500/10' : 'text-zinc-600 hover:text-zinc-300'
            }`}
          >
            <Repeat2 size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
