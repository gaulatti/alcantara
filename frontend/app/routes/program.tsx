import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { useSSE } from '../hooks/useSSE';
import { apiUrl } from '../utils/apiBaseUrl';
import {
  BroadcastLayout,
  Ticker,
  ChyronHolder,
  Header,
  ClockWidget,
  QRCodeWidget,
  LiveIndicator,
  LogoWidget,
  FifthBellChyron,
  ToniClock,
  ToniLogo,
  Earone,
  ModoItalianoClock,
  ModoItalianoChyron,
  ModoItalianoDisclaimer,
  Slideshow,
  VideoStream
} from '../components';
import RelojClone from '../components/RelojClone';
import RelojLoopClock from '../components/RelojLoopClock';
import FifthBellProgram from '../programs/fifthbell/FifthBellProgram.tsx';
import { SceneTransitionOverlay } from '../components/SceneTransitionOverlay';
import type { GlobalTimeOverride } from '../utils/broadcastTime';
import {
  ensureProgramAudioBusTrack,
  getProgramAudioBusSignalSnapshot,
  getProgramAudioBusSnapshot,
  setProgramAudioBusMasterVolume,
  stopProgramAudioBus
} from '../utils/programAudioBus';
import { faderToGain } from '../utils/audioTaper';
import { normalizeProgramSongSequence, resolveProgramSongLeaf, type ProgramSongSequence, type ProgramSongSequenceItem } from '../utils/programSequence';
import { resolveToniChyronLeaf } from '../utils/toniChyronSequence';
import { getSceneTransitionPreset, type SceneTransitionPreset } from '../utils/sceneTransitions';
import { BACKEND_SANREMO_REALTIME_URL, buildEaroneRealtimeLookup, matchEaroneRealtimeEntry, type EaroneRealtimeLookup } from '../utils/earoneRealtime';
import { getProgramRealtimeSocketUrl } from '../utils/programRealtimeSocket';

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

interface ProgramState {
  id: number;
  programId?: string;
  activeSceneId: number | null;
  activeScene: Scene | null;
  stagedSceneId?: number | null;
  stagedScene?: Scene | null;
  updatedAt: string;
}

interface BroadcastSettings {
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

interface ProgramMixerChannel {
  id: string;
  name: string;
  volume: number;
  muted: boolean;
  solo: boolean;
}

interface SceneChangeEvent {
  type: 'scene_change';
  transitionId?: string | null;
  state: ProgramState;
}

interface InstantPlayEvent {
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

interface SceneInstantTakeEvent {
  type: 'scene_instant_take';
  programId?: string;
  sceneId?: number | null;
  instant: {
    id: number;
    name: string;
    audioUrl: string;
    volume: number;
  };
  loop?: boolean;
  triggeredAt: string;
}

interface SceneInstantStateEvent {
  type: 'scene_instant_state';
  programId?: string;
  playback?: {
    sceneId?: number | null;
    instantId?: number | null;
    isPlaying?: boolean;
    instant?: {
      id: number;
      name: string;
      audioUrl: string;
      volume: number;
    } | null;
    startedAt?: string | null;
    updatedAt?: string;
  } | null;
}

interface ActiveTransition {
  sequence: number;
  preset: SceneTransitionPreset;
}

interface InstantAudioRuntimeState {
  baseVolume: number;
  meterSource: AudioNode | null;
  meterAnalyser: AnalyserNode | null;
  meterBuffer: Float32Array | null;
  meterUsesMediaElementFallback: boolean;
}

interface SongOffAirEvent {
  type: 'song_off_air';
  programId: string;
  triggeredAt: string;
}

interface ProgramAudioBusSettings {
  songSequence?: unknown;
  mixerSettings?: ProgramAudioMixerSettings | null;
}

interface ProgramAudioMixerSettings {
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

interface SlideshowMediaItem {
  id: number;
  name: string;
  imageUrl: string;
}

interface SlideshowMediaGroupItem {
  id: number;
  mediaGroupId: number;
  mediaId: number;
  position: number;
  media: SlideshowMediaItem;
}

interface SlideshowMediaGroup {
  id: number;
  name: string;
  description: string | null;
  items: SlideshowMediaGroupItem[];
}

interface AudioBusUpdateEvent {
  type: 'audio_bus_update';
  programId: string;
  settings: ProgramAudioBusSettings;
  updatedAt: string;
}

interface MeterChannelPayload {
  vu: number;
  peak: number;
  peakHold: number;
}

interface ProgramAudioMeterPayload {
  song: MeterChannelPayload;
  instants: MeterChannelPayload;
  sceneInstant: MeterChannelPayload;
  main: MeterChannelPayload;
}

interface MeterChannelBallistics {
  vu: number;
  peak: number;
  peakHold: number;
  peakHoldAtMs: number;
}

interface ProgramMeterBallisticsState {
  song: MeterChannelBallistics;
  instants: MeterChannelBallistics;
  sceneInstant: MeterChannelBallistics;
  main: MeterChannelBallistics;
  lastTickAtMs: number | null;
}

const VU_ATTACK_MS = 300;
const VU_RELEASE_MS = 300;
const PEAK_RELEASE_MS = 300;
const PEAK_HOLD_MS = 900;
const METER_TICK_INTERVAL_MS = 60;

const FIFTHBELL_DRIVER_COMPONENT_TYPES = new Set(['fifthbell', 'fifthbell-content', 'fifthbell-marquee', 'fifthbell-corner', 'fifthbell-clock']);

function createMeterChannelBallistics(): MeterChannelBallistics {
  return {
    vu: 0,
    peak: 0,
    peakHold: 0,
    peakHoldAtMs: 0
  };
}

function createProgramMeterBallisticsState(): ProgramMeterBallisticsState {
  return {
    song: createMeterChannelBallistics(),
    instants: createMeterChannelBallistics(),
    sceneInstant: createMeterChannelBallistics(),
    main: createMeterChannelBallistics(),
    lastTickAtMs: null
  };
}

function createInstantAudioMeterContext(): AudioContext | null {
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

function normalizeProgramAudioBusSettings(value: unknown): ProgramAudioBusSettings {
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

function normalizeMasterVolume(value: unknown, fallback: number = 1): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  return fallback;
}

function normalizeMixerToggle(value: unknown, fallback: boolean = false): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  return fallback;
}

function normalizeSlideshowMediaGroupId(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || !Number.isInteger(numeric)) {
    return null;
  }
  return numeric;
}

function normalizeProgramMixerChannels(value: unknown, fallback: ProgramMixerChannel[]): ProgramMixerChannel[] {
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

function getProgramMixerChannel(channels: ProgramMixerChannel[], id: string): ProgramMixerChannel {
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

function normalizeProgramAudioMixerSettings(value: unknown): ProgramAudioMixerSettings {
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
  const mixerChannels = normalizeProgramMixerChannels(
    record.mixerChannels,
    fallbackChannels
  );
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

function normalizeBroadcastSettings(value: unknown): BroadcastSettings | null {
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

function sceneIncludesVideoStream(scene: Scene | null | undefined): boolean {
  if (!scene?.layout?.componentType) {
    return false;
  }
  return scene.layout.componentType
    .split(',')
    .map((componentType) => componentType.trim())
    .filter(Boolean)
    .includes('video-stream');
}

function normalizeSceneInstantNumericId(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : null;
}

function normalizeSceneInstantTimestamp(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function buildSceneInstantPlaybackToken(
  sceneId: number | null,
  instantId: number | null,
  audioUrl: string,
  timestamp: string
): string {
  return `${sceneId ?? 'none'}|${instantId ?? 'none'}|${audioUrl.trim()}|${timestamp || 'none'}`;
}

export default function Program() {
  const { id } = useParams();
  const programId = id ?? 'main';

  return <SceneProgram programId={programId} />;
}

function SceneProgram({ programId }: { programId: string }) {
  const [state, setState] = useState<ProgramState | null>(null);
  const [audioBusSettings, setAudioBusSettings] = useState<ProgramAudioBusSettings | null>(null);
  const [broadcastSettings, setBroadcastSettings] = useState<BroadcastSettings | null>(null);
  const [slideshowMediaGroupsById, setSlideshowMediaGroupsById] = useState<Record<number, SlideshowMediaGroup>>({});
  const [earoneLookup, setEaroneLookup] = useState<EaroneRealtimeLookup | null>(null);
  const [activeTransition, setActiveTransition] = useState<ActiveTransition | null>(null);
  const transitionTimersRef = useRef<number[]>([]);
  const transitionSequenceRef = useRef(0);
  const activeInstantAudiosRef = useRef<Map<HTMLAudioElement, InstantAudioRuntimeState>>(new Map());
  const activeSceneInstantAudioRef = useRef<{
    audio: HTMLAudioElement;
    runtime: InstantAudioRuntimeState;
    playbackToken: string;
  } | null>(null);
  const instantAudioMeterContextRef = useRef<AudioContext | null>(null);
  const meterSocketRef = useRef<WebSocket | null>(null);
  const meterSocketReadyRef = useRef(false);
  const [isRealtimeConnected, setIsRealtimeConnected] = useState(false);
  const handleProgramEventRef = useRef<(data: any) => void>(() => {
    // no-op until handler is initialized
  });
  const meterBallisticsRef = useRef<ProgramMeterBallisticsState>(createProgramMeterBallisticsState());
  const lastMeterPayloadRef = useRef<ProgramAudioMeterPayload>({
    song: { vu: 0, peak: 0, peakHold: 0 },
    instants: { vu: 0, peak: 0, peakHold: 0 },
    sceneInstant: { vu: 0, peak: 0, peakHold: 0 },
    main: { vu: 0, peak: 0, peakHold: 0 }
  });
  const lastSongPlaybackPayloadRef = useRef<{
    token: string;
    audioUrl: string;
    progress: number;
    currentTimeMs: number;
    durationMs: number | null;
    isPlaying: boolean;
  }>({
    token: '',
    audioUrl: '',
    progress: 0,
    currentTimeMs: 0,
    durationMs: null,
    isPlaying: false
  });
  const programMixerSettings = useMemo(
    () =>
      audioBusSettings?.mixerSettings
        ? normalizeProgramAudioMixerSettings(audioBusSettings.mixerSettings)
        : normalizeProgramAudioMixerSettings(null),
    [audioBusSettings?.mixerSettings]
  );
  const mainMasterFader = normalizeMasterVolume(programMixerSettings.mainMasterVolume, 1);
  const songMasterVolume = normalizeMasterVolume(programMixerSettings.songMasterVolume, 1);
  const instantMasterVolume = normalizeMasterVolume(programMixerSettings.instantMasterVolume, 1);
  const sceneInstantMasterVolume = normalizeMasterVolume(programMixerSettings.sceneInstantMasterVolume, 1);
  const streamMasterVolume = normalizeMasterVolume(programMixerSettings.streamMasterVolume, 1);
  const songMuted = Boolean(programMixerSettings.songMuted);
  const instantMuted = Boolean(programMixerSettings.instantMuted);
  const sceneInstantMuted = Boolean(programMixerSettings.sceneInstantMuted);
  const streamMuted = Boolean(programMixerSettings.streamMuted);
  const songSolo = Boolean(programMixerSettings.songSolo);
  const instantSolo = Boolean(programMixerSettings.instantSolo);
  const sceneInstantSolo = Boolean(programMixerSettings.sceneInstantSolo);
  const streamSolo = Boolean(programMixerSettings.streamSolo);
  const hasSoloChannel = songSolo || instantSolo || sceneInstantSolo || streamSolo;
  const effectiveSongMasterFader = hasSoloChannel ? (songSolo ? songMasterVolume : 0) : songMasterVolume;
  const effectiveInstantMasterFader = hasSoloChannel ? (instantSolo ? instantMasterVolume : 0) : instantMasterVolume;
  const effectiveSceneInstantMasterFader = hasSoloChannel ? (sceneInstantSolo ? sceneInstantMasterVolume : 0) : sceneInstantMasterVolume;
  const effectiveStreamMasterFader = hasSoloChannel ? (streamSolo ? streamMasterVolume : 0) : streamMasterVolume;
  const normalizedSongSequence = useMemo(() => normalizeProgramSongSequence(audioBusSettings?.songSequence), [audioBusSettings?.songSequence]);
  const [songSequenceNowMs, setSongSequenceNowMs] = useState(() => Date.now());
  const resolvedSongPayload = useMemo(
    () =>
      resolveProgramSongLeaf(
        {
          sequence: normalizedSongSequence
        },
        songSequenceNowMs
      ),
    [normalizedSongSequence, songSequenceNowMs]
  );
  const resolvedSongChannelGain = songMuted ? 0 : faderToGain(effectiveSongMasterFader);
  const resolvedInstantChannelGain = instantMuted ? 0 : faderToGain(effectiveInstantMasterFader);
  const resolvedSceneInstantChannelGain = sceneInstantMuted ? 0 : faderToGain(effectiveSceneInstantMasterFader);
  const resolvedStreamChannelGain = streamMuted ? 0 : faderToGain(effectiveStreamMasterFader);
  const mainMasterGain = faderToGain(mainMasterFader);
  const resolvedSongMasterVolume = normalizeMasterVolume(resolvedSongChannelGain * mainMasterGain, 0);
  const resolvedInstantMasterVolume = normalizeMasterVolume(resolvedInstantChannelGain * mainMasterGain, 0);
  const resolvedSceneInstantMasterVolume = normalizeMasterVolume(resolvedSceneInstantChannelGain * mainMasterGain, 0);
  const resolvedStreamMasterVolume = normalizeMasterVolume(resolvedStreamChannelGain * mainMasterGain, 0);
  const activeSlideshowMediaGroupId = useMemo(() => {
    const activeScene = state?.activeScene;
    if (!activeScene?.layout?.componentType?.includes('slideshow')) {
      return null;
    }

    try {
      const parsed = activeScene.metadata ? JSON.parse(activeScene.metadata) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
      }
      const slideshowProps = (parsed as Record<string, unknown>).slideshow;
      if (!slideshowProps || typeof slideshowProps !== 'object' || Array.isArray(slideshowProps)) {
        return null;
      }
      return normalizeSlideshowMediaGroupId((slideshowProps as Record<string, unknown>).mediaGroupId);
    } catch {
      return null;
    }
  }, [state?.activeScene?.id, state?.activeScene?.metadata, state?.activeScene?.layout?.componentType]);

  const resolveSlideshowImages = useCallback(
    (slideshowProps: Record<string, unknown>): unknown => {
      const mediaGroupId = normalizeSlideshowMediaGroupId(slideshowProps.mediaGroupId);
      if (mediaGroupId === null) {
        return slideshowProps.images;
      }

      const group = slideshowMediaGroupsById[mediaGroupId];
      if (!group) {
        return slideshowProps.images;
      }

      return [...group.items]
        .sort((a, b) => a.position - b.position)
        .map((item) => item.media?.imageUrl)
        .filter((imageUrl): imageUrl is string => typeof imageUrl === 'string' && imageUrl.trim().length > 0);
    },
    [slideshowMediaGroupsById]
  );

  const clearTransitionTimers = () => {
    transitionTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    transitionTimersRef.current = [];
  };

  const ensureInstantAudioMeter = useCallback((audio: HTMLAudioElement, runtime: InstantAudioRuntimeState) => {
    let context = instantAudioMeterContextRef.current;
    if (!context || context.state === 'closed') {
      context = createInstantAudioMeterContext();
      instantAudioMeterContextRef.current = context;
    }
    if (!context) {
      return;
    }

    try {
      const attachFromStream = (): boolean => {
        const stream = audio.captureStream?.() || (audio as HTMLAudioElement & { mozCaptureStream?: () => MediaStream }).mozCaptureStream?.();
        if (!stream) {
          return false;
        }

        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.78;
        source.connect(analyser);
        runtime.meterSource = source;
        runtime.meterAnalyser = analyser;
        runtime.meterBuffer = new Float32Array(analyser.fftSize);
        runtime.meterUsesMediaElementFallback = false;
        return true;
      };

      const attachFromMediaElement = (): boolean => {
        if (context.state !== 'running') {
          return false;
        }
        const source = context.createMediaElementSource(audio);
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.78;
        source.connect(analyser);
        source.connect(context.destination);
        audio.muted = true;
        runtime.meterSource = source;
        runtime.meterAnalyser = analyser;
        runtime.meterBuffer = new Float32Array(analyser.fftSize);
        runtime.meterUsesMediaElementFallback = true;
        return true;
      };

      if (attachFromStream()) {
        if (context.state === 'suspended') {
          void context.resume().catch(() => {
            // ignore resume failures; meter can recover later
          });
        }
        return;
      }

      if (attachFromMediaElement()) {
        return;
      }

      if (context.state === 'suspended') {
        void context
          .resume()
          .then(() => {
            if (!activeInstantAudiosRef.current.has(audio) || runtime.meterSource) {
              return;
            }
            try {
              void attachFromMediaElement();
            } catch {
              // no-op
            }
          })
          .catch(() => {
            // no-op
          });
      }
    } catch {
      runtime.meterSource = null;
      runtime.meterAnalyser = null;
      runtime.meterBuffer = null;
      runtime.meterUsesMediaElementFallback = false;
    }
  }, []);

  const readInstantSignalSnapshot = useCallback((): { rms: number; peak: number } => {
    let rmsPeak = 0;
    let peak = 0;
    for (const [audio, runtime] of activeInstantAudiosRef.current) {
      if (audio.paused || audio.ended) {
        continue;
      }
      if (!runtime.meterAnalyser || !runtime.meterBuffer) {
        const fallbackLevel = normalizeMasterVolume(audio.volume, 0);
        rmsPeak = Math.max(rmsPeak, fallbackLevel);
        peak = Math.max(peak, fallbackLevel);
        continue;
      }

      runtime.meterAnalyser.getFloatTimeDomainData(runtime.meterBuffer);
      let sumSquares = 0;
      let peakSample = 0;
      for (let index = 0; index < runtime.meterBuffer.length; index += 1) {
        const sample = runtime.meterBuffer[index];
        sumSquares += sample * sample;
        const absSample = Math.abs(sample);
        if (absSample > peakSample) {
          peakSample = absSample;
        }
      }
      const rms = Math.sqrt(sumSquares / runtime.meterBuffer.length);
      rmsPeak = Math.max(rmsPeak, rms);
      peak = Math.max(peak, peakSample);
    }

    return {
      rms: Math.max(0, Math.min(1, rmsPeak)),
      peak: Math.max(0, Math.min(1, peak))
    };
  }, []);

  const readSceneInstantSignalSnapshot = useCallback((): { rms: number; peak: number } => {
    const current = activeSceneInstantAudioRef.current;
    if (!current) {
      return { rms: 0, peak: 0 };
    }

    const { audio, runtime } = current;
    if (audio.paused || audio.ended) {
      return { rms: 0, peak: 0 };
    }

    if (!runtime.meterAnalyser || !runtime.meterBuffer) {
      const fallbackLevel = normalizeMasterVolume(audio.volume, 0);
      return {
        rms: fallbackLevel,
        peak: fallbackLevel
      };
    }

    runtime.meterAnalyser.getFloatTimeDomainData(runtime.meterBuffer);
    let sumSquares = 0;
    let peakSample = 0;
    for (let index = 0; index < runtime.meterBuffer.length; index += 1) {
      const sample = runtime.meterBuffer[index];
      sumSquares += sample * sample;
      const absSample = Math.abs(sample);
      if (absSample > peakSample) {
        peakSample = absSample;
      }
    }

    const rms = Math.sqrt(sumSquares / runtime.meterBuffer.length);
    return {
      rms: Math.max(0, Math.min(1, rms)),
      peak: Math.max(0, Math.min(1, peakSample))
    };
  }, []);

  const stopSceneInstantAudio = useCallback(() => {
    const current = activeSceneInstantAudioRef.current;
    if (!current) {
      return;
    }
    const { audio, runtime } = current;
    audio.pause();
    try {
      audio.currentTime = 0;
    } catch {
      // no-op for unsupported media
    }
    audio.onended = null;
    audio.onerror = null;
    if (runtime.meterSource) {
      try {
        runtime.meterSource.disconnect();
      } catch {
        // no-op
      }
    }
    if (runtime.meterAnalyser) {
      try {
        runtime.meterAnalyser.disconnect();
      } catch {
        // no-op
      }
    }
    if (runtime.meterUsesMediaElementFallback) {
      audio.muted = false;
    }
    activeSceneInstantAudioRef.current = null;
  }, []);

  const stopAllInstantAudio = () => {
    for (const [audio, runtime] of activeInstantAudiosRef.current) {
      audio.pause();
      try {
        audio.currentTime = 0;
      } catch {
        // no-op for unsupported media
      }
      audio.onended = null;
      audio.onerror = null;
      if (runtime.meterSource) {
        try {
          runtime.meterSource.disconnect();
        } catch {
          // no-op
        }
      }
      if (runtime.meterAnalyser) {
        try {
          runtime.meterAnalyser.disconnect();
        } catch {
          // no-op
        }
      }
      if (runtime.meterUsesMediaElementFallback) {
        audio.muted = false;
      }
    }
    activeInstantAudiosRef.current.clear();
  };

  const takeSceneInstantAudio = useCallback(
    (event: SceneInstantTakeEvent) => {
      const sceneId = normalizeSceneInstantNumericId(event.sceneId);
      const instantId = normalizeSceneInstantNumericId(event.instant?.id);
      const timestamp = normalizeSceneInstantTimestamp(event.triggeredAt);
      const audioUrl = typeof event.instant?.audioUrl === 'string' ? event.instant.audioUrl.trim() : '';
      const playbackToken = buildSceneInstantPlaybackToken(sceneId, instantId, audioUrl, timestamp);
      const currentlyPlayingSceneInstant = activeSceneInstantAudioRef.current;

      if (
        currentlyPlayingSceneInstant &&
        currentlyPlayingSceneInstant.playbackToken === playbackToken &&
        !currentlyPlayingSceneInstant.audio.paused &&
        !currentlyPlayingSceneInstant.audio.ended
      ) {
        return;
      }

      stopSceneInstantAudio();

      const audio = new Audio(event.instant.audioUrl);
      audio.preload = 'auto';
      audio.loop = event.loop !== false;
      const baseVolume = normalizeMasterVolume(event.instant.volume, 1);
      audio.volume = normalizeMasterVolume(baseVolume * resolvedSceneInstantMasterVolume, 1);
      const runtime: InstantAudioRuntimeState = {
        baseVolume,
        meterSource: null,
        meterAnalyser: null,
        meterBuffer: null,
        meterUsesMediaElementFallback: false
      };
      ensureInstantAudioMeter(audio, runtime);

      const cleanup = () => {
        audio.onended = null;
        audio.onerror = null;
        if (runtime.meterSource) {
          try {
            runtime.meterSource.disconnect();
          } catch {
            // no-op
          }
        }
        if (runtime.meterAnalyser) {
          try {
            runtime.meterAnalyser.disconnect();
          } catch {
            // no-op
          }
        }
        if (runtime.meterUsesMediaElementFallback) {
          audio.muted = false;
        }
        if (activeSceneInstantAudioRef.current?.audio === audio) {
          activeSceneInstantAudioRef.current = null;
        }
      };

      audio.onended = cleanup;
      audio.onerror = () => {
        console.error(`Scene instant playback error for "${event.instant.name}" (${event.instant.audioUrl})`);
        cleanup();
      };
      activeSceneInstantAudioRef.current = { audio, runtime, playbackToken };

      const playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((err) => {
          console.error(`Failed to play scene instant "${event.instant.name}":`, err);
          cleanup();
        });
      }
    },
    [ensureInstantAudioMeter, resolvedSceneInstantMasterVolume, stopSceneInstantAudio]
  );

  const playInstantAudio = (event: InstantPlayEvent) => {
    const audio = new Audio(event.instant.audioUrl);
    audio.preload = 'auto';
    const baseVolume = normalizeMasterVolume(event.instant.volume, 1);
    audio.volume = normalizeMasterVolume(baseVolume * resolvedInstantMasterVolume, 1);
    const runtime: InstantAudioRuntimeState = {
      baseVolume,
      meterSource: null,
      meterAnalyser: null,
      meterBuffer: null,
      meterUsesMediaElementFallback: false
    };
    ensureInstantAudioMeter(audio, runtime);

    const cleanup = () => {
      audio.onended = null;
      audio.onerror = null;
      if (runtime.meterSource) {
        try {
          runtime.meterSource.disconnect();
        } catch {
          // no-op
        }
      }
      if (runtime.meterAnalyser) {
        try {
          runtime.meterAnalyser.disconnect();
        } catch {
          // no-op
        }
      }
      if (runtime.meterUsesMediaElementFallback) {
        audio.muted = false;
      }
      activeInstantAudiosRef.current.delete(audio);
    };

    audio.onended = cleanup;
    audio.onerror = () => {
      console.error(`Instant playback error for "${event.instant.name}" (${event.instant.audioUrl})`);
      cleanup();
    };
    activeInstantAudiosRef.current.set(audio, runtime);

    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch((err) => {
        console.error(`Failed to play instant "${event.instant.name}":`, err);
        cleanup();
      });
    }
  };

  const handleProgramEvent = useCallback(
    (data: any) => {
      if (!data || typeof data !== 'object') {
        return;
      }

      if (data.type === 'scene_staged') {
        const eventProgramId = typeof data.programId === 'string' ? data.programId : '';
        if (eventProgramId && eventProgramId !== programId) {
          return;
        }
        const nextStagedSceneId = typeof data.stagedSceneId === 'number' && Number.isFinite(data.stagedSceneId) ? data.stagedSceneId : null;
        const nextStagedScene = data.scene && typeof data.scene === 'object' ? (data.scene as Scene) : null;
        setState((prev) => {
          if (!prev) {
            return prev;
          }
          return {
            ...prev,
            stagedSceneId: nextStagedSceneId,
            stagedScene: nextStagedScene
          };
        });
      } else if (data.type === 'scene_change') {
        const event = data as SceneChangeEvent;
        const preset = getSceneTransitionPreset(event.transitionId);
        const canAnimate = preset.id !== 'cut' && !!state?.activeScene && !!event.state.activeScene && state.activeSceneId !== event.state.activeSceneId;

        clearTransitionTimers();

        if (!canAnimate) {
          setActiveTransition(null);
          setState(event.state);
          return;
        }

        transitionSequenceRef.current += 1;
        setActiveTransition({
          sequence: transitionSequenceRef.current,
          preset
        });

        const cutTimer = window.setTimeout(() => {
          setState(event.state);
        }, preset.cutPointMs);

        const cleanupTimer = window.setTimeout(() => {
          setActiveTransition(null);
          transitionTimersRef.current = [];
        }, preset.durationMs);

        transitionTimersRef.current = [cutTimer, cleanupTimer];
      } else if (data.type === 'scene_update') {
        setState((prev) => {
          if (!prev || !prev.activeScene || prev.activeScene.id !== data.scene.id) return prev;
          return {
            ...prev,
            activeScene: data.scene
          };
        });
      } else if (data.type === 'scene_cleared') {
        clearTransitionTimers();
        setActiveTransition(null);
        setState((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            activeSceneId: null,
            activeScene: null
          };
        });
      } else if (data.type === 'broadcast_settings_update') {
        setBroadcastSettings(normalizeBroadcastSettings(data.settings));
      } else if (data.type === 'instant_play') {
        const eventProgramId = typeof data.programId === 'string' ? data.programId : '';
        if (eventProgramId && eventProgramId !== programId) {
          return;
        }
        playInstantAudio(data as InstantPlayEvent);
      } else if (data.type === 'instant_stop_all') {
        const eventProgramId = typeof data.programId === 'string' ? data.programId : '';
        if (eventProgramId && eventProgramId !== programId) {
          return;
        }
        stopAllInstantAudio();
      } else if (data.type === 'scene_instant_take') {
        const eventProgramId = typeof data.programId === 'string' ? data.programId : '';
        if (eventProgramId && eventProgramId !== programId) {
          return;
        }
        takeSceneInstantAudio(data as SceneInstantTakeEvent);
      } else if (data.type === 'scene_instant_stop') {
        const eventProgramId = typeof data.programId === 'string' ? data.programId : '';
        if (eventProgramId && eventProgramId !== programId) {
          return;
        }
        stopSceneInstantAudio();
      } else if (data.type === 'scene_instant_state') {
        const event = data as SceneInstantStateEvent;
        const eventProgramId = typeof event.programId === 'string' ? event.programId : '';
        if (eventProgramId && eventProgramId !== programId) {
          return;
        }
        const playback = event.playback;
        if (
          playback &&
          playback.isPlaying &&
          playback.instant &&
          typeof playback.instant.audioUrl === 'string' &&
          playback.instant.audioUrl.trim().length > 0
        ) {
          const sceneId = normalizeSceneInstantNumericId(playback.sceneId);
          const instantId = normalizeSceneInstantNumericId(playback.instant.id);
          const timestamp = normalizeSceneInstantTimestamp(playback.startedAt) || normalizeSceneInstantTimestamp(playback.updatedAt);
          const playbackToken = buildSceneInstantPlaybackToken(sceneId, instantId, playback.instant.audioUrl, timestamp);
          const currentlyPlayingSceneInstant = activeSceneInstantAudioRef.current;
          if (
            currentlyPlayingSceneInstant &&
            currentlyPlayingSceneInstant.playbackToken === playbackToken &&
            !currentlyPlayingSceneInstant.audio.paused &&
            !currentlyPlayingSceneInstant.audio.ended
          ) {
            return;
          }

          takeSceneInstantAudio({
            type: 'scene_instant_take',
            programId,
            sceneId,
            instant: playback.instant,
            loop: true,
            triggeredAt: timestamp || new Date().toISOString()
          });
        } else {
          stopSceneInstantAudio();
        }
      } else if (data.type === 'song_off_air') {
        const event = data as SongOffAirEvent;
        if (event.programId === programId) {
          stopProgramAudioBus(programId);
        }
      } else if (data.type === 'audio_bus_update') {
        const event = data as AudioBusUpdateEvent;
        if (event.programId === programId) {
          setAudioBusSettings(normalizeProgramAudioBusSettings(event.settings));
        }
      }
    },
    [
      programId,
      state?.activeScene,
      state?.activeSceneId,
      playInstantAudio,
      stopAllInstantAudio,
      stopSceneInstantAudio,
      takeSceneInstantAudio,
      clearTransitionTimers
    ]
  );

  useEffect(() => {
    handleProgramEventRef.current = handleProgramEvent;
  }, [handleProgramEvent]);

  useEffect(() => {
    transitionTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    transitionTimersRef.current = [];
    setActiveTransition(null);
    setState(null);
    setAudioBusSettings(null);
    setBroadcastSettings(null);
    stopAllInstantAudio();
    stopSceneInstantAudio();
  }, [programId, stopSceneInstantAudio]);

  useEffect(() => {
    return () => {
      transitionTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      transitionTimersRef.current = [];
      stopAllInstantAudio();
      stopSceneInstantAudio();
      const context = instantAudioMeterContextRef.current;
      instantAudioMeterContextRef.current = null;
      if (context && context.state !== 'closed') {
        void context.close().catch(() => {
          // no-op
        });
      }
    };
  }, [stopSceneInstantAudio]);

  useEffect(() => {
    if (isRealtimeConnected) {
      return;
    }

    let cancelled = false;
    const fallbackTimer = window.setTimeout(() => {
      if (cancelled || meterSocketReadyRef.current) {
        return;
      }

      fetch(apiUrl(`/program/${encodeURIComponent(programId)}/state`))
        .then((res) => res.json())
        .then((data) => {
          if (!cancelled) {
            setState(data);
          }
        })
        .catch((err) => console.error('Failed to fetch initial state:', err));

      fetch(apiUrl(`/program/${encodeURIComponent(programId)}/audio-bus`))
        .then((res) => res.json())
        .then((data) => {
          if (!cancelled) {
            setAudioBusSettings(normalizeProgramAudioBusSettings(data));
          }
        })
        .catch((err) => console.error('Failed to fetch audio bus settings:', err));

      fetch(apiUrl('/program/broadcast-settings'))
        .then((res) => res.json())
        .then((data) => {
          if (!cancelled) {
            setBroadcastSettings(normalizeBroadcastSettings(data));
          }
        })
        .catch((err) => console.error('Failed to fetch broadcast settings:', err));

      fetch(apiUrl(`/program/${encodeURIComponent(programId)}/scene-instant`))
        .then((res) => res.json())
        .then((playback) => {
          if (!cancelled) {
            handleProgramEventRef.current({
              type: 'scene_instant_state',
              programId,
              playback
            });
          }
        })
        .catch((err) => console.error('Failed to fetch scene instant playback:', err));
    }, 900);

    return () => {
      cancelled = true;
      window.clearTimeout(fallbackTimer);
    };
  }, [programId, isRealtimeConnected]);

  useEffect(() => {
    setProgramAudioBusMasterVolume(programId, resolvedSongMasterVolume);
  }, [programId, resolvedSongMasterVolume]);

  useEffect(() => {
    setSongSequenceNowMs(Date.now());
  }, [normalizedSongSequence]);

  useEffect(() => {
    if (!normalizedSongSequence || normalizedSongSequence.mode !== 'autoplay') {
      return;
    }

    const timer = window.setInterval(() => {
      setSongSequenceNowMs(Date.now());
    }, 250);

    return () => {
      window.clearInterval(timer);
    };
  }, [
    normalizedSongSequence?.mode,
    normalizedSongSequence?.startedAt,
    normalizedSongSequence?.intervalMs,
    normalizedSongSequence?.loop,
    normalizedSongSequence?.items.length
  ]);

  useEffect(() => {
    if (!audioBusSettings) {
      return;
    }

    const songAudioUrl = resolvedSongPayload?.audioUrl?.trim() || '';
    const songArtist = resolvedSongPayload?.artist?.trim() || '';
    const songTitle = resolvedSongPayload?.title?.trim() || '';
    const songCoverUrl = resolvedSongPayload?.coverUrl?.trim() || '';
    const songIdentity = resolvedSongPayload?.id?.trim() || `${songArtist}|${songTitle}`.trim();

    if (!songAudioUrl) {
      const snapshot = getProgramAudioBusSnapshot(programId);
      if (snapshot.track) {
        stopProgramAudioBus(programId);
      }
      return;
    }

    const playbackToken = `${songIdentity || 'song'}:${songAudioUrl}`;
    const snapshot = getProgramAudioBusSnapshot(programId);
    const hasSameToken = snapshot.track?.token === playbackToken;

    if (hasSameToken && snapshot.isPlaying) {
      return;
    }

    ensureProgramAudioBusTrack(programId, {
      token: playbackToken,
      audioUrl: songAudioUrl,
      durationMs: resolvedSongPayload?.durationMs,
      artist: songArtist,
      title: songTitle,
      coverUrl: songCoverUrl,
      earoneSongId: resolvedSongPayload?.earoneSongId,
      earoneRank: resolvedSongPayload?.earoneRank,
      earoneSpins: resolvedSongPayload?.earoneSpins
    });
  }, [
    programId,
    audioBusSettings,
    resolvedSongPayload?.id,
    resolvedSongPayload?.audioUrl,
    resolvedSongPayload?.artist,
    resolvedSongPayload?.title,
    resolvedSongPayload?.coverUrl,
    resolvedSongPayload?.durationMs,
    resolvedSongPayload?.earoneSongId,
    resolvedSongPayload?.earoneRank,
    resolvedSongPayload?.earoneSpins
  ]);

  useEffect(() => {
    for (const [audio, runtime] of activeInstantAudiosRef.current) {
      audio.volume = normalizeMasterVolume(runtime.baseVolume * resolvedInstantMasterVolume, 1);
    }
  }, [resolvedInstantMasterVolume]);

  useEffect(() => {
    const current = activeSceneInstantAudioRef.current;
    if (!current) {
      return;
    }
    current.audio.volume = normalizeMasterVolume(current.runtime.baseVolume * resolvedSceneInstantMasterVolume, 1);
  }, [resolvedSceneInstantMasterVolume]);

  useEffect(() => {
    if (activeSlideshowMediaGroupId === null) {
      return;
    }

    let cancelled = false;

    fetch(apiUrl(`/media-groups/${activeSlideshowMediaGroupId}`))
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return (await res.json()) as SlideshowMediaGroup;
      })
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setSlideshowMediaGroupsById((prev) => ({
          ...prev,
          [payload.id]: payload
        }));
      })
      .catch((err) => {
        console.error('Failed to load slideshow media group:', err);
      });

    return () => {
      cancelled = true;
    };
  }, [activeSlideshowMediaGroupId]);

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
        socket = new WebSocket(getProgramRealtimeSocketUrl(programId, 'program'));
      } catch {
        reconnectTimer = window.setTimeout(connect, 1500);
        return;
      }

      meterSocketRef.current = socket;
      meterSocketReadyRef.current = false;
      setIsRealtimeConnected(false);

      socket.addEventListener('open', () => {
        if (disposed || meterSocketRef.current !== socket) {
          try {
            socket.close();
          } catch {
            // no-op
          }
          return;
        }
        meterSocketReadyRef.current = true;
        setIsRealtimeConnected(true);
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
          setState(payload.state ?? null);
          return;
        }

        if (payload.type === 'audio_bus_snapshot') {
          setAudioBusSettings(normalizeProgramAudioBusSettings(payload.settings));
          return;
        }

        if (payload.type === 'broadcast_settings_snapshot') {
          setBroadcastSettings(normalizeBroadcastSettings(payload.settings));
          return;
        }

        if (payload.type === 'audio_meter_update' || payload.type === 'song_playback_update') {
          return;
        }

        handleProgramEventRef.current(payload);
      });

      socket.addEventListener('close', () => {
        if (meterSocketRef.current === socket) {
          meterSocketRef.current = null;
          meterSocketReadyRef.current = false;
        }
        setIsRealtimeConnected(false);
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
      meterSocketReadyRef.current = false;
      setIsRealtimeConnected(false);

      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }

      const socket = meterSocketRef.current;
      meterSocketRef.current = null;

      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.close();
        } catch {
          // no-op
        }
      }
    };
  }, [programId]);

  useEffect(() => {
    let isDisposed = false;
    let meterRequestInFlight = false;
    let songPlaybackRequestInFlight = false;

    const sendMeterPayload = async (payload: ProgramAudioMeterPayload) => {
      if (isDisposed) {
        return;
      }

      const socket = meterSocketRef.current;
      if (socket && meterSocketReadyRef.current && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(
            JSON.stringify({
              type: 'audio_meter_update',
              levels: payload
            })
          );
          return;
        } catch {
          meterSocketReadyRef.current = false;
        }
      }

      if (meterRequestInFlight) {
        return;
      }
      meterRequestInFlight = true;

      try {
        await fetch(apiUrl(`/program/${encodeURIComponent(programId)}/audio-meter`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch {
        // silent fail: meter updates are best effort only
      } finally {
        meterRequestInFlight = false;
      }
    };

    const sendSongPlaybackPayload = async (payload: {
      token: string;
      audioUrl: string;
      progress: number;
      currentTimeMs: number;
      durationMs: number | null;
      isPlaying: boolean;
    }) => {
      if (isDisposed) {
        return;
      }

      const socket = meterSocketRef.current;
      if (socket && meterSocketReadyRef.current && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(
            JSON.stringify({
              type: 'song_playback_update',
              playback: payload
            })
          );
          return;
        } catch {
          meterSocketReadyRef.current = false;
        }
      }

      if (songPlaybackRequestInFlight) {
        return;
      }
      songPlaybackRequestInFlight = true;

      try {
        await fetch(apiUrl(`/program/${encodeURIComponent(programId)}/song-playback`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch {
        // silent fail: song playback updates are best effort only
      } finally {
        songPlaybackRequestInFlight = false;
      }
    };

    const tick = () => {
      const nowMs = performance.now();
      const meterState = meterBallisticsRef.current;
      const previousTickAtMs = meterState.lastTickAtMs;
      const deltaMs = previousTickAtMs === null ? METER_TICK_INTERVAL_MS : Math.max(1, nowMs - previousTickAtMs);
      meterState.lastTickAtMs = nowMs;

      const songSignal = getProgramAudioBusSignalSnapshot(programId);
      const instantsSignal = readInstantSignalSnapshot();
      const sceneInstantSignal = readSceneInstantSignalSnapshot();
      const mainRmsSignal = Math.max(
        0,
        Math.min(1, Math.sqrt(songSignal.rms * songSignal.rms + instantsSignal.rms * instantsSignal.rms + sceneInstantSignal.rms * sceneInstantSignal.rms))
      );
      const mainPeakSignal = Math.max(songSignal.peak, instantsSignal.peak, sceneInstantSignal.peak);

      const applyBallistics = (channel: MeterChannelBallistics, inputRms: number, inputPeak: number): MeterChannelPayload => {
        const vuTimeConstantMs = inputRms >= channel.vu ? VU_ATTACK_MS : VU_RELEASE_MS;
        const vuAlpha = 1 - Math.exp(-deltaMs / Math.max(1, vuTimeConstantMs));
        const nextVu = channel.vu + (inputRms - channel.vu) * vuAlpha;

        let nextPeak = channel.peak;
        if (inputPeak >= channel.peak) {
          nextPeak = inputPeak;
        } else {
          const peakReleaseAlpha = 1 - Math.exp(-deltaMs / Math.max(1, PEAK_RELEASE_MS));
          nextPeak = channel.peak + (inputPeak - channel.peak) * peakReleaseAlpha;
        }

        let nextPeakHold = channel.peakHold;
        let nextPeakHoldAtMs = channel.peakHoldAtMs;
        if (inputPeak >= nextPeakHold) {
          nextPeakHold = inputPeak;
          nextPeakHoldAtMs = nowMs;
        } else if (nowMs - channel.peakHoldAtMs > PEAK_HOLD_MS) {
          const holdReleaseAlpha = 1 - Math.exp(-deltaMs / Math.max(1, PEAK_RELEASE_MS));
          nextPeakHold = channel.peakHold + (nextPeak - channel.peakHold) * holdReleaseAlpha;
        }

        channel.vu = Math.max(0, Math.min(1, nextVu));
        channel.peak = Math.max(channel.vu, Math.max(0, Math.min(1, nextPeak)));
        channel.peakHold = Math.max(channel.peak, Math.max(0, Math.min(1, nextPeakHold)));
        channel.peakHoldAtMs = nextPeakHoldAtMs;

        return {
          vu: channel.vu,
          peak: channel.peak,
          peakHold: channel.peakHold
        };
      };

      const nextPayload = {
        song: applyBallistics(meterState.song, songSignal.rms, songSignal.peak),
        instants: applyBallistics(meterState.instants, instantsSignal.rms, instantsSignal.peak),
        sceneInstant: applyBallistics(meterState.sceneInstant, sceneInstantSignal.rms, sceneInstantSignal.peak),
        main: applyBallistics(meterState.main, mainRmsSignal, mainPeakSignal)
      };
      const previousPayload = lastMeterPayloadRef.current;
      const changed =
        Math.abs(nextPayload.song.vu - previousPayload.song.vu) > 0.0035 ||
        Math.abs(nextPayload.song.peak - previousPayload.song.peak) > 0.0035 ||
        Math.abs(nextPayload.song.peakHold - previousPayload.song.peakHold) > 0.0035 ||
        Math.abs(nextPayload.instants.vu - previousPayload.instants.vu) > 0.0035 ||
        Math.abs(nextPayload.instants.peak - previousPayload.instants.peak) > 0.0035 ||
        Math.abs(nextPayload.instants.peakHold - previousPayload.instants.peakHold) > 0.0035 ||
        Math.abs(nextPayload.sceneInstant.vu - previousPayload.sceneInstant.vu) > 0.0035 ||
        Math.abs(nextPayload.sceneInstant.peak - previousPayload.sceneInstant.peak) > 0.0035 ||
        Math.abs(nextPayload.sceneInstant.peakHold - previousPayload.sceneInstant.peakHold) > 0.0035 ||
        Math.abs(nextPayload.main.vu - previousPayload.main.vu) > 0.0035 ||
        Math.abs(nextPayload.main.peak - previousPayload.main.peak) > 0.0035 ||
        Math.abs(nextPayload.main.peakHold - previousPayload.main.peakHold) > 0.0035;

      if (changed) {
        lastMeterPayloadRef.current = nextPayload;
        void sendMeterPayload(nextPayload);
      }

      const snapshot = getProgramAudioBusSnapshot(programId);
      const nextSongPlaybackPayload = {
        token: snapshot.track?.token ?? '',
        audioUrl: snapshot.track?.audioUrl ?? '',
        progress: Math.max(0, Math.min(1, snapshot.progress)),
        currentTimeMs: Math.max(0, Math.round(snapshot.currentTimeMs)),
        durationMs:
          typeof snapshot.durationMs === 'number' && Number.isFinite(snapshot.durationMs) && snapshot.durationMs > 0 ? Math.round(snapshot.durationMs) : null,
        isPlaying: Boolean(snapshot.track && snapshot.isPlaying)
      };
      const previousSongPlayback = lastSongPlaybackPayloadRef.current;
      const songPlaybackChanged =
        nextSongPlaybackPayload.token !== previousSongPlayback.token ||
        nextSongPlaybackPayload.audioUrl !== previousSongPlayback.audioUrl ||
        nextSongPlaybackPayload.isPlaying !== previousSongPlayback.isPlaying ||
        nextSongPlaybackPayload.durationMs !== previousSongPlayback.durationMs ||
        Math.abs(nextSongPlaybackPayload.currentTimeMs - previousSongPlayback.currentTimeMs) > 80 ||
        Math.abs(nextSongPlaybackPayload.progress - previousSongPlayback.progress) > 0.004;

      if (songPlaybackChanged) {
        lastSongPlaybackPayloadRef.current = nextSongPlaybackPayload;
        void sendSongPlaybackPayload(nextSongPlaybackPayload);
      }
    };

    tick();
    const meterTimer = window.setInterval(tick, METER_TICK_INTERVAL_MS);

    return () => {
      isDisposed = true;
      window.clearInterval(meterTimer);
      const silentPayload: ProgramAudioMeterPayload = {
        song: { vu: 0, peak: 0, peakHold: 0 },
        instants: { vu: 0, peak: 0, peakHold: 0 },
        sceneInstant: { vu: 0, peak: 0, peakHold: 0 },
        main: { vu: 0, peak: 0, peakHold: 0 }
      };
      const silentSongPlaybackPayload = {
        token: '',
        audioUrl: '',
        progress: 0,
        currentTimeMs: 0,
        durationMs: null as number | null,
        isPlaying: false
      };
      lastMeterPayloadRef.current = silentPayload;
      meterBallisticsRef.current = createProgramMeterBallisticsState();
      lastSongPlaybackPayloadRef.current = silentSongPlaybackPayload;

      const socket = meterSocketRef.current;
      if (socket && meterSocketReadyRef.current && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(
            JSON.stringify({
              type: 'audio_meter_update',
              levels: silentPayload
            })
          );
          socket.send(
            JSON.stringify({
              type: 'song_playback_update',
              playback: silentSongPlaybackPayload
            })
          );
          return;
        } catch {
          meterSocketReadyRef.current = false;
        }
      }

      void Promise.allSettled([
        fetch(apiUrl(`/program/${encodeURIComponent(programId)}/audio-meter`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(silentPayload),
          keepalive: true
        }),
        fetch(apiUrl(`/program/${encodeURIComponent(programId)}/song-playback`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(silentSongPlaybackPayload),
          keepalive: true
        })
      ]).catch(() => {
        // ignore cleanup reporting errors
      });
    };
  }, [programId, readInstantSignalSnapshot, readSceneInstantSignalSnapshot]);

  useEffect(() => {
    const componentTypes = state?.activeScene?.layout.componentType.split(',').filter(Boolean) || [];
    const needsEaroneRealtime = componentTypes.includes('earone');

    if (!needsEaroneRealtime) {
      return;
    }

    let cancelled = false;

    const loadEarone = async () => {
      try {
        const res = await fetch(BACKEND_SANREMO_REALTIME_URL);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const payload = await res.json();
        if (!cancelled) {
          setEaroneLookup(buildEaroneRealtimeLookup(payload));
        }
      } catch (err) {
        console.error('Failed to fetch EarOne realtime data:', err);
      }
    };

    void loadEarone();
    const timer = window.setInterval(() => {
      void loadEarone();
    }, 15000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [state?.activeScene?.id, state?.activeScene?.layout.componentType]);

  useSSE({
    url: apiUrl(`/program/${encodeURIComponent(programId)}/events`),
    onMessage: handleProgramEvent,
    enabled: !isRealtimeConnected
  });

  const globalTimeOverride: GlobalTimeOverride | null =
    broadcastSettings?.timeOverrideEnabled && !!broadcastSettings.timeOverrideStartTime && !!broadcastSettings.timeOverrideStartedAt
      ? {
          startTime: broadcastSettings.timeOverrideStartTime,
          startedAt: broadcastSettings.timeOverrideStartedAt
        }
      : null;

  const renderScene = (
    scene: Scene | null,
    options?: {
      forceStreamMuted?: boolean;
    }
  ) => {
    if (!scene) {
      return <div className='w-full h-full flex items-center justify-center text-white text-4xl'>No Active Scene</div>;
    }

    const components = scene.layout.componentType.split(',').filter(Boolean);

    // Parse metadata
    let metadata: any = {};
    try {
      metadata = scene.metadata ? JSON.parse(scene.metadata) : {};
    } catch (err) {
      console.error('Failed to parse scene metadata:', err);
    }

    const mergedFifthBellChyronProps = {
      ...(metadata['toni-chyron'] || {}),
      ...(metadata['fifthbell-chyron'] || {})
    } as Record<string, unknown>;
    const activeToniLeaf = resolveToniChyronLeaf(mergedFifthBellChyronProps);
    const matchedEaroneEntry = matchEaroneRealtimeEntry(earoneLookup, {
      earoneSongId: activeToniLeaf?.earoneSongId || null,
      text: activeToniLeaf?.text || null
    });
    const firstClockComponentType = components.find(
      (componentType) => componentType === 'toni-clock' || componentType === 'fifthbell-clock' || componentType === 'fifthbell-corner'
    );
    const fifthBellClockProps = {
      ...(metadata['fifthbell'] || {}),
      ...(metadata['fifthbell-corner'] || {}),
      ...(metadata['fifthbell-clock'] || {}),
      ...(metadata['toni-clock'] || {})
    } as Record<string, unknown>;
    const hasProgramClockComponent = components.includes('modoitaliano-clock');
    const hasProgramChyronComponent = components.includes('modoitaliano-chyron');
    const hasProgramDisclaimerComponent = components.includes('modoitaliano-disclaimer');
    const shouldRenderProgramRow = hasProgramClockComponent && (hasProgramChyronComponent || hasProgramDisclaimerComponent);
    const modoItalianoChyronProps = metadata['modoitaliano-chyron'] || {};
    const modoItalianoDisclaimerProps = metadata['modoitaliano-disclaimer'] || {};
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
    const modoItalianoDisclaimerText = typeof modoItalianoDisclaimerProps.text === 'string' ? modoItalianoDisclaimerProps.text.trim() : '';
    const shouldShowProgramChyronComponent = shouldRenderProgramRow && hasProgramChyronComponent && toBoolean(modoItalianoChyronProps.show, true);
    const showProgramDisclaimer =
      shouldRenderProgramRow &&
      hasProgramDisclaimerComponent &&
      !shouldShowProgramChyronComponent &&
      toBoolean(modoItalianoDisclaimerProps.show, true) &&
      !!modoItalianoDisclaimerText;

    // Handle legacy single-component layouts
    if (components.length === 1) {
      const componentType = components[0];
      const legacyProps = metadata[componentType] || {};

      if (componentType === 'lower-third') {
        return <LowerThird text={legacyProps.text} />;
      }
      if (componentType === 'full-screen') {
        return <FullScreen text={legacyProps.text} />;
      }
      if (componentType === 'corner-bug') {
        return <CornerBug text={legacyProps.text} />;
      }
    }

    // Handle broadcast-layout component
    if (components.includes('broadcast-layout')) {
      const props = metadata['broadcast-layout'] || {};
      return (
        <BroadcastLayout
          headerTitle={props.headerTitle || ''}
          hashtag={props.hashtag || '#ModoSanremoMR'}
          url={props.url || 'modoradio.cl'}
          chyronText={props.chyronText || ''}
          showChyron={Boolean(props.showChyron ?? !!props.chyronText)}
          qrCodeContent={props.qrCodeContent || 'https://modoradio.cl'}
          clockTimezone={props.clockTimezone || 'America/Argentina/Buenos_Aires'}
          showLiveIndicator={true}
          timeOverride={globalTimeOverride}
        />
      );
    }

    const firstFifthBellComponentType = components.find((componentType) => FIFTHBELL_DRIVER_COMPONENT_TYPES.has(componentType));

    // Handle multi-component custom layouts
    return (
      <div className='w-full h-full relative bg-transparent'>
        {components.map((componentType) => {
          const props = metadata[componentType] || {};

          switch (componentType) {
            case 'ticker':
              return (
                <div key={componentType} style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }}>
                  <Ticker hashtag={props.hashtag || '#Default'} url={props.url || 'website.com'} />
                </div>
              );
            case 'chyron':
              return (
                <div key={componentType} style={{ position: 'absolute', bottom: '120px', left: 0, right: 0 }}>
                  <ChyronHolder text={props.text || 'Chyron'} show={true} />
                </div>
              );
            case 'header':
              return <Header key={componentType} title={props.title || 'Header'} date={props.date || new Date().toLocaleDateString()} />;
            case 'clock-widget':
              return <ClockWidget key={componentType} iconUrl={props.iconUrl} timezone={props.timezone} timeOverride={globalTimeOverride} />;
            case 'qr-code':
              return <QRCodeWidget key={componentType} content={props.content || 'https://example.com'} />;
            case 'live-indicator':
              return <LiveIndicator key={componentType} animate={props.animate ?? true} />;
            case 'logo-widget':
              return <LogoWidget key={componentType} logoUrl={props.logoUrl} position={props.position} />;
            case 'slideshow':
              return (
                <Slideshow
                  key={componentType}
                  images={resolveSlideshowImages(props as Record<string, unknown>)}
                  intervalMs={props.intervalMs}
                  transitionMs={props.transitionMs}
                  shuffle={props.shuffle}
                  fitMode={props.fitMode}
                  kenBurns={props.kenBurns}
                />
              );
            case 'video-stream':
              return (
                <VideoStream
                  key={componentType}
                  sourceUrl={props.sourceUrl}
                  posterUrl={props.posterUrl}
                  channelGain={options?.forceStreamMuted ? 0 : resolvedStreamMasterVolume}
                  showControls={props.showControls}
                  loop={props.loop}
                  autoPlay={props.autoPlay}
                  objectFit={props.objectFit}
                />
              );
            case 'reloj-clock':
              return <RelojClone key={componentType} timezone={props.timezone || 'America/Argentina/Buenos_Aires'} timeOverride={globalTimeOverride} />;
            case 'reloj-loop-clock':
              return <RelojLoopClock key={componentType} timezone={props.timezone || 'Europe/Madrid'} />;
            case 'toni-chyron':
            case 'fifthbell-chyron': {
              const fifthBellChyronProps = {
                ...(metadata['toni-chyron'] || {}),
                ...(metadata['fifthbell-chyron'] || {}),
                ...(metadata[componentType] || {})
              } as Record<string, unknown>;
              return (
                <FifthBellChyron
                  key={componentType}
                  text={typeof fifthBellChyronProps.text === 'string' ? fifthBellChyronProps.text : ''}
                  show={true}
                  useMarquee={typeof fifthBellChyronProps.useMarquee === 'boolean' ? fifthBellChyronProps.useMarquee : undefined}
                  contentMode={
                    fifthBellChyronProps.contentMode === 'text' || fifthBellChyronProps.contentMode === 'sequence'
                      ? fifthBellChyronProps.contentMode
                      : undefined
                  }
                  sequence={fifthBellChyronProps.sequence}
                  socialHandles={fifthBellChyronProps.socialHandles}
                />
              );
            }
            case 'toni-clock':
            case 'fifthbell-clock':
            case 'fifthbell-corner':
              if (firstClockComponentType !== componentType) {
                return null;
              }
              const resolvedShowBellIcon =
                componentType === 'fifthbell-clock' || componentType === 'fifthbell-corner'
                  ? true
                  : typeof fifthBellClockProps.showBellIcon === 'boolean'
                    ? fifthBellClockProps.showBellIcon
                    : undefined;
              return (
                <ToniClock
                  key={componentType}
                  timeOverride={globalTimeOverride}
                  cities={Array.isArray(fifthBellClockProps.worldClockCities) ? fifthBellClockProps.worldClockCities : undefined}
                  rotationIntervalMs={
                    typeof fifthBellClockProps.worldClockRotateIntervalMs === 'number' ? fifthBellClockProps.worldClockRotateIntervalMs : undefined
                  }
                  transitionDurationMs={typeof fifthBellClockProps.worldClockTransitionMs === 'number' ? fifthBellClockProps.worldClockTransitionMs : undefined}
                  shuffleCities={typeof fifthBellClockProps.worldClockShuffle === 'boolean' ? fifthBellClockProps.worldClockShuffle : undefined}
                  widthPx={typeof fifthBellClockProps.worldClockWidthPx === 'number' ? fifthBellClockProps.worldClockWidthPx : undefined}
                  showWorldClocks={typeof fifthBellClockProps.showWorldClocks === 'boolean' ? fifthBellClockProps.showWorldClocks : undefined}
                  showBellIcon={resolvedShowBellIcon}
                />
              );
            case 'modoitaliano-clock': {
              if (shouldRenderProgramRow) {
                return null;
              }
              return (
                <ModoItalianoClock
                  key={componentType}
                  programId={programId}
                  timeOverride={globalTimeOverride}
                  transitionDurationMs={300}
                  shuffleCities={false}
                  widthPx={220}
                  showWorldClocks={true}
                  showBellIcon={false}
                  songSequence={audioBusSettings?.songSequence}
                  language='es'
                />
              );
            }
            case 'modoitaliano-chyron':
              if (shouldRenderProgramRow) {
                return null;
              }
              return (
                <ModoItalianoChyron
                  key={componentType}
                  show={typeof props.show === 'boolean' ? props.show : true}
                  textSequence={props.textSequence}
                  ctaSequence={props.ctaSequence}
                />
              );
            case 'modoitaliano-disclaimer':
              if (shouldRenderProgramRow) {
                return null;
              }
              return (
                <ModoItalianoDisclaimer
                  key={componentType}
                  text={props.text || ''}
                  show={typeof props.show === 'boolean' ? props.show : true}
                  align={props.align === 'left' || props.align === 'center' || props.align === 'right' ? props.align : undefined}
                  bottomPx={typeof props.bottomPx === 'number' ? props.bottomPx : undefined}
                  fontSizePx={typeof props.fontSizePx === 'number' ? props.fontSizePx : undefined}
                  opacity={typeof props.opacity === 'number' ? props.opacity : undefined}
                />
              );
            case 'toni-logo':
              return <ToniLogo key={componentType} callsign={props.callsign || 'MR'} subtitle={props.subtitle} />;
            case 'earone':
              return (
                <Earone
                  key={componentType}
                  label={props.label || 'EARONE'}
                  rank={props.rank || matchedEaroneEntry?.ranking || activeToniLeaf?.earoneRank}
                  spins={props.spins || matchedEaroneEntry?.radioSpinsToday || activeToniLeaf?.earoneSpins}
                />
              );
            case 'fifthbell':
            case 'fifthbell-content':
            case 'fifthbell-marquee':
              if (firstFifthBellComponentType !== componentType) {
                return null;
              }
              return (
                <div key={componentType} className='absolute inset-0'>
                  <FifthBellProgram programId={programId} embedded sceneMetadata={metadata} activeComponents={components} />
                </div>
              );
            case 'corner-bug':
              return (
                <div key={componentType} style={{ position: 'absolute', top: '32px', right: '32px' }}>
                  <CornerBug text={props.text} />
                </div>
              );
            default:
              console.warn('Unknown component type:', componentType);
              return (
                <div key={componentType} style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', color: 'white' }}>
                  Unknown component: {componentType}
                </div>
              );
          }
        })}
        {shouldRenderProgramRow && (
          <div className='absolute z-[950] flex items-end gap-6' style={{ left: '110px', right: '110px', bottom: '110px' }}>
            <div className='flex-1 min-w-0'>
              {shouldShowProgramChyronComponent ? (
                <ModoItalianoChyron show textSequence={modoItalianoChyronProps.textSequence} ctaSequence={modoItalianoChyronProps.ctaSequence} inline />
              ) : showProgramDisclaimer ? (
                <ModoItalianoDisclaimer
                  text={modoItalianoDisclaimerProps.text || ''}
                  show
                  align={
                    modoItalianoDisclaimerProps.align === 'left' ||
                    modoItalianoDisclaimerProps.align === 'center' ||
                    modoItalianoDisclaimerProps.align === 'right'
                      ? modoItalianoDisclaimerProps.align
                      : 'right'
                  }
                  fontSizePx={typeof modoItalianoDisclaimerProps.fontSizePx === 'number' ? modoItalianoDisclaimerProps.fontSizePx : 20}
                  opacity={typeof modoItalianoDisclaimerProps.opacity === 'number' ? modoItalianoDisclaimerProps.opacity : 0.82}
                  inline
                />
              ) : null}
            </div>
            <div className='shrink-0'>
              <ModoItalianoClock
                programId={programId}
                timeOverride={globalTimeOverride}
                transitionDurationMs={300}
                shuffleCities={false}
                widthPx={220}
                showWorldClocks={true}
                showBellIcon={false}
                songSequence={audioBusSettings?.songSequence}
                language='es'
                inline
              />
            </div>
          </div>
        )}
      </div>
    );
  };

  const activeScene = state?.activeScene ?? null;
  const stagedScene = state?.stagedScene ?? null;
  const stagedSceneHasVideoStream = sceneIncludesVideoStream(stagedScene);
  const stagedSceneIsOnAir = stagedSceneHasVideoStream && stagedScene !== null && activeScene !== null && stagedScene.id === activeScene.id;

  return (
    <div className='relative overflow-hidden bg-transparent' style={{ width: '1920px', height: '1080px' }}>
      {stagedSceneHasVideoStream && stagedScene ? (
        <div className='pointer-events-none absolute inset-0 opacity-0' aria-hidden='true' style={{ opacity: stagedSceneIsOnAir ? 1 : 0 }}>
          {renderScene(stagedScene, { forceStreamMuted: !stagedSceneIsOnAir })}
        </div>
      ) : null}
      {!stagedSceneIsOnAir ? renderScene(activeScene, { forceStreamMuted: false }) : null}
      {activeTransition && <SceneTransitionOverlay key={activeTransition.sequence} transition={activeTransition.preset} />}
    </div>
  );
}

function LowerThird({ text }: { text?: string }) {
  return (
    <div className='absolute bottom-0 left-0 right-0 h-48 bg-gradient-to-r from-blue-600 to-blue-800 flex items-center px-16'>
      <div className='text-white'>
        <div className='text-5xl font-bold'>{text || 'Lower Third'}</div>
      </div>
    </div>
  );
}

function FullScreen({ text }: { text?: string }) {
  return (
    <div className='w-full h-full flex items-center justify-center bg-gradient-to-br from-purple-900 to-blue-900'>
      <div className='text-white text-8xl font-bold text-center px-16'>{text || 'Full Screen'}</div>
    </div>
  );
}

function CornerBug({ text }: { text?: string }) {
  return (
    <div className='absolute top-8 right-8 bg-red-600 text-white px-8 py-4 rounded-lg shadow-2xl'>
      <div className='text-3xl font-bold'>{text || 'LIVE'}</div>
    </div>
  );
}
