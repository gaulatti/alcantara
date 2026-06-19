import { Button, Input, Panel, PanelLayout } from '@gaulatti/bleecker';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSSE } from '../hooks/useSSE';
import { OVERLAY_COMPONENTS, getDefaultPropsForComponent as getStaticDefaultProps, hasConfigurableSceneAttributes } from '../models/components';
import { apiUrl } from '../utils/apiBaseUrl';
import { dbToFader, faderToGain } from '../utils/audioTaper';
import { useGlobalProgramId } from '../utils/globalProgram';
import { useGlobalTransitionId } from '../utils/globalTransition';
import { getProgramRealtimeSocketUrl } from '../utils/programRealtimeSocket';
import {
  createProgramSongSequence,
  createProgramTextSequence,
  normalizeProgramSongSequence,
  type ProgramSongSequence,
  type ProgramSongSequenceItem
} from '../utils/programSequence';
import type { Route } from './+types/control';

import { PanelColumn } from '../components/editors';
import { PlaybackBar } from '../components/PlaybackBar';
import { InstantsPanel, PlaylistPanel, PlaylistSheetPanel, SceneAttributesPanel } from '../components/panels';
import type {
  BroadcastSettings,
  ComponentPropsMap,
  InstantItem,
  InstantPlaybackState,
  Layout,
  MediaGroup,
  MixerTakeApplyingMap,
  MixerTakeChannelKey,
  MixerTakePresetDbMap,
  MixerTakePresetSide,
  MixerTakeRunIdMap,
  MixerTakeTimerMap,
  ProgramAudioBusSettings,
  ProgramAudioMeterLevels,
  ProgramSceneEntry,
  ProgramSongPlaybackState,
  ProgramState,
  ProgramUpdateTopic,
  Scene,
  SceneAttributeSavePayload,
  SceneInstantPlaybackState,
  PaginatedResponse,
  SongCatalogItem
} from '../models/broadcast';
import {
  DEFAULT_MIXER_TAKE_APPLYING,
  DEFAULT_MIXER_TAKE_PRESETS_DB,
  DEFAULT_MIXER_TAKE_RUN_IDS,
  DEFAULT_MIXER_TAKE_TIMERS,
  FIFTHBELL_AVAILABLE_WEATHER_CITIES,
  INSTANT_PLAYBACK_PULSE_ANIMATION,
  INSTANT_PLAYBACK_SWEEP_ANIMATION,
  INSTANT_SHORTCUT_KEYS,
  MIXER_TAKE_CHANNELS,
  SONG_PROGRESS_FILL_ANIMATION,
  TAKE_VOLUME_PRESET_FADE_STEP_MIN_MS,
  createEmptyMeterChannel,
  defaultMixerChannelsFromScalars,
  formatMixerLevelInputValue,
  formatTakePresetDbInputValue,
  getInstantShortcutLetter,
  isEditableTarget,
  meterLevelToFill,
  normalizeBroadcastSettingsPayload,
  normalizeMasterVolume,
  normalizeProgramAudioMeter,
  normalizeProgramSongPlayback,
  normalizeProgramState,
  normalizeSceneInstantId,
  normalizeSceneInstantPlayback,
  normalizeTakeVolumeFadeMs,
  normalizeTakeVolumePresetDb,
  parseMixerLevelInputToFader,
  parseSceneMetadata,
  readControlUpdateVersion,
  reconcileProgramAudioMeter,
  reconcileProgramSongPlayback,
  resolveControlUpdateTopicFromType,
  withIndependentProgramClockMetadata,
  withNormalizedMixerChannels
} from '../utils/broadcast';

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
  return { ...sequence, items: playlistItems, activeItemId };
}

interface MixerStripProps {
  title: string;
  widthClass: string;
  stripClassName: string;
  headerClassName: string;
  titleClassName: string;
  showMuteSolo?: boolean;
  muted?: boolean;
  solo?: boolean;
  onToggleMuted?: () => void;
  onToggleSolo?: () => void;
  showPresets?: boolean;
  presetAKey: string;
  presetBKey: string;
  presetADb: number;
  presetBDb: number;
  onCommitPresetA: (raw: string) => number;
  onCommitPresetB: (raw: string) => number;
  onTakeA: () => void;
  onTakeB: () => void;
  isTakingA: boolean;
  isTakingB: boolean;
  topPanel?: ReactNode;
  levelKey: string;
  levelValue: number;
  levelAriaLabel: string;
  onCommitLevel: (raw: string) => number;
  levelContainerClassName: string;
  levelInputClassName: string;
  liveClassName: string;
  isLive: boolean;
  meterFill?: number;
  meterPeakFill?: number;
  meterPeakHoldFill?: number;
  showMeterSignal?: boolean;
  meterBarCount?: 1 | 2;
  combineMarkerRail?: boolean;
  markerA: number;
  markerB: number;
  markerBorderClassName: string;
  markerTextClassName: string;
  showMarkerLabels?: boolean;
  combinedMarkerLineClassName?: string;
  combinedMarkerLabelOffsetClassName?: string;
  markerTrackClassName?: string;
  scaleClassName?: string;
  scalePositiveClassName?: string;
}

function MixerStrip({
  title,
  widthClass,
  stripClassName,
  headerClassName,
  titleClassName,
  showMuteSolo = true,
  muted = false,
  solo = false,
  onToggleMuted,
  onToggleSolo,
  showPresets = true,
  presetAKey,
  presetBKey,
  presetADb,
  presetBDb,
  onCommitPresetA,
  onCommitPresetB,
  onTakeA,
  onTakeB,
  isTakingA,
  isTakingB,
  topPanel,
  levelKey,
  levelValue,
  levelAriaLabel,
  onCommitLevel,
  levelContainerClassName,
  levelInputClassName,
  liveClassName,
  isLive,
  meterFill,
  meterPeakFill,
  meterPeakHoldFill,
  showMeterSignal = true,
  meterBarCount = 1,
  combineMarkerRail = meterBarCount === 1,
  markerA,
  markerB,
  markerBorderClassName,
  markerTextClassName,
  showMarkerLabels = true,
  combinedMarkerLineClassName = 'w-8',
  combinedMarkerLabelOffsetClassName = '-right-6',
  markerTrackClassName = 'w-8',
  scaleClassName = 'text-zinc-500',
  scalePositiveClassName
}: MixerStripProps) {
  return (
    <div className={`flex ${widthClass} shrink-0 flex-col pb-3 ${stripClassName}`}>
      <div className={`w-full rounded-t-lg border-b py-2.5 text-center ${headerClassName}`}>
        <span className={`text-[11px] font-bold tracking-widest ${titleClassName}`}>{title}</span>
      </div>

      <div className='mt-3 flex w-full gap-3 px-3'>
        <div className='flex min-w-0 flex-1 flex-col gap-2'>
          {topPanel}

          {showMuteSolo ? (
            <div className='flex gap-1.5'>
              <Button
                type='button'
                onClick={onToggleMuted}
                className={`flex h-8 flex-1 items-center justify-center rounded transition-all font-bold text-[10px] uppercase tracking-wider ${
                  muted
                    ? 'bg-red-600 text-white shadow-[0_0_12px_rgba(220,38,38,0.5)]'
                    : 'border border-zinc-700/50 bg-zinc-900 text-zinc-400 hover:bg-zinc-700'
                }`}
              >
                M
              </Button>
              <Button
                type='button'
                onClick={onToggleSolo}
                className={`flex h-8 flex-1 items-center justify-center rounded transition-all font-bold text-[10px] uppercase tracking-wider ${
                  solo
                    ? 'bg-yellow-500 text-yellow-950 shadow-[0_0_12px_rgba(234,179,8,0.4)]'
                    : 'border border-zinc-700/50 bg-zinc-900 text-zinc-400 hover:bg-zinc-700'
                }`}
              >
                S
              </Button>
            </div>
          ) : null}

          {showPresets ? (
            <div className='flex gap-2'>
              <div className='flex flex-1 flex-col gap-1'>
                <label className='text-[10px] font-mono text-sky-300'>
                  <span className='block text-center'>A (dB)</span>
                  <Input
                    key={presetAKey}
                    type='text'
                    inputMode='decimal'
                    defaultValue={formatTakePresetDbInputValue(presetADb)}
                    onBlur={(event) => {
                      const nextValue = onCommitPresetA(event.target.value);
                      event.target.value = formatTakePresetDbInputValue(nextValue);
                    }}
                    className='w-full rounded border border-sky-800/50 bg-zinc-900 px-1 py-0.5 text-center text-[10px] text-sky-200 outline-none focus:border-sky-400'
                  />
                </label>
                <Button type='button' onClick={onTakeA} disabled={isTakingA} className='w-full rounded border border-sky-800/50 bg-zinc-900 py-1 text-[9px] font-bold tracking-wider text-sky-300 transition hover:bg-sky-900/20 disabled:opacity-50'>
                  TAKE A
                </Button>
              </div>
              <div className='flex flex-1 flex-col gap-1'>
                <label className='text-[10px] font-mono text-amber-300'>
                  <span className='block text-center'>B (dB)</span>
                  <Input
                    key={presetBKey}
                    type='text'
                    inputMode='decimal'
                    defaultValue={formatTakePresetDbInputValue(presetBDb)}
                    onBlur={(event) => {
                      const nextValue = onCommitPresetB(event.target.value);
                      event.target.value = formatTakePresetDbInputValue(nextValue);
                    }}
                    className='w-full rounded border border-amber-800/50 bg-zinc-900 px-1 py-0.5 text-center text-[10px] text-amber-200 outline-none focus:border-amber-400'
                  />
                </label>
                <Button type='button' onClick={onTakeB} disabled={isTakingB} className='w-full rounded border border-amber-800/50 bg-zinc-900 py-1 text-[9px] font-bold tracking-wider text-amber-300 transition hover:bg-amber-900/20 disabled:opacity-50'>
                  TAKE B
                </Button>
              </div>
            </div>
          ) : null}

          <div className={`flex h-9 w-full flex-col justify-center rounded border text-center ${levelContainerClassName}`}>
            <Input
              key={levelKey}
              type='text'
              inputMode='decimal'
              defaultValue={formatMixerLevelInputValue(levelValue)}
              aria-label={levelAriaLabel}
              onBlur={(event) => {
                const nextValue = onCommitLevel(event.target.value);
                event.target.value = formatMixerLevelInputValue(nextValue);
              }}
              className={levelInputClassName}
            />
            <span className={`font-mono text-[8px] tracking-wider leading-none ${liveClassName}`}>{isLive ? 'LIVE' : 'CUT'}</span>
          </div>
        </div>

      </div>
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
      const res = await fetch(apiUrl('/songs?limit=0'));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as PaginatedResponse<SongCatalogItem>;
      setSongCatalog(Array.isArray(body.data) ? body.data : []);
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
      const easedRatio = ratio < 0.3
        ? (1 - (1 - ratio / 0.3) ** 2) * 0.65
        : 0.65 + ((ratio - 0.3) / 0.7) * 0.35;
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

  const triggerChannelTake = (channelId: MixerTakeChannelKey, presetSide: MixerTakePresetSide) => {
    applyTakePresetToChannel(channelId, presetSide, takePresetFadeMs);
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
  const sceneQuickActions = useMemo(() => {
    return assignedScenes.map((scene, index) => ({
      id: scene.id,
      name: scene.name,
      isActive: scene.id === activeSceneId,
      isStaged: scene.id === selectedScene,
      shortcutLabel: `^ Ctrl+${index < 9 ? (index + 1) % 10 : 0}`
    }));
  }, [assignedScenes, activeSceneId, selectedScene]);
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
    <div className='flex h-full w-full flex-1 min-h-0 flex-col overflow-hidden bg-dark-sand text-text-primary'>
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
      <div className='flex-1 min-h-0 w-full overflow-hidden'>
        <PanelLayout className='w-full h-full min-h-0' padding='p-0'>
          <PanelColumn className='min-w-0' {...controlDeckGrowProps}>
            <Panel title='Mixer' accent='#38bdf8' variant='monitor' className='min-h-0' grow>
              <div className='space-y-4'>
                <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
                  {isLoadingMixerLevels ? (
                    <span className='text-xs font-mono text-amber-500 animate-pulse'>LOADING STATE...</span>
                  ) : isSavingMixerLevels ? (
                    <span className='text-xs font-mono text-emerald-500 animate-pulse'>STORING...</span>
                  ) : null}
                </div>

                <div className='rounded-xl border border-zinc-700 bg-zinc-900/70 p-2.5'>
                  <div className='overflow-x-auto'>
                    <div className='flex min-w-max items-end justify-between gap-3'>
                      <div className='flex items-end gap-2'>
                        <div className='flex items-center gap-2 self-end'>
                          <p className='text-[10px] font-bold tracking-widest text-violet-300'>SCENE INSTANT</p>
                          <Button
                            type='button'
                            onClick={toggleSceneInstantMuted}
                            className={`flex h-8 items-center justify-center rounded px-2.5 transition-all font-bold text-[10px] uppercase tracking-wider ${mixerLevels.sceneInstantMuted ? 'bg-red-600 text-white shadow-[0_0_12px_rgba(220,38,38,0.5)]' : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-700 border border-zinc-700/50'}`}
                          >
                            Mute
                          </Button>
                          <Button
                            type='button'
                            onClick={toggleSceneInstantSolo}
                            className={`flex h-8 items-center justify-center rounded px-2.5 transition-all font-bold text-[10px] uppercase tracking-wider ${mixerLevels.sceneInstantSolo ? 'bg-yellow-500 text-yellow-950 shadow-[0_0_12px_rgba(234,179,8,0.4)]' : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-700 border border-zinc-700/50'}`}
                          >
                            Solo
                          </Button>
                        </div>
                        <div className='flex flex-col gap-1'>
                          <label className='text-[10px] font-mono text-sky-300'>
                            <span className='mb-0.5 block text-center'>A (dB)</span>
                            <Input
                              key={`scene-instant-preset-a-${mixerTakePresetsDb.sceneInstant.aDb}`}
                              type='text'
                              inputMode='decimal'
                              defaultValue={formatTakePresetDbInputValue(mixerTakePresetsDb.sceneInstant.aDb)}
                              onBlur={(event) => {
                                const nextValue = commitTakePresetDbInput('sceneInstant', 'a', event.target.value, mixerTakePresetsDb.sceneInstant.aDb);
                                event.target.value = formatTakePresetDbInputValue(nextValue);
                              }}
                              className='w-20 rounded border border-sky-800/50 bg-zinc-900 px-1 py-0.5 text-center text-[10px] text-sky-200 outline-none focus:border-sky-400'
                            />
                          </label>
                          <Button
                            type='button'
                            onClick={() => triggerChannelTake('sceneInstant', 'a')}
                            disabled={isApplyingTakePresetByChannel.sceneInstant}
                            className='w-full rounded border border-sky-800/50 bg-zinc-900 py-1 text-[9px] font-bold tracking-wider text-sky-300 transition hover:bg-sky-900/20 disabled:opacity-50'
                          >
                            TAKE A
                          </Button>
                        </div>
                        <div className='flex flex-col gap-1'>
                          <label className='text-[10px] font-mono text-amber-300'>
                            <span className='mb-0.5 block text-center'>B (dB)</span>
                            <Input
                              key={`scene-instant-preset-b-${mixerTakePresetsDb.sceneInstant.bDb}`}
                              type='text'
                              inputMode='decimal'
                              defaultValue={formatTakePresetDbInputValue(mixerTakePresetsDb.sceneInstant.bDb)}
                              onBlur={(event) => {
                                const nextValue = commitTakePresetDbInput('sceneInstant', 'b', event.target.value, mixerTakePresetsDb.sceneInstant.bDb);
                                event.target.value = formatTakePresetDbInputValue(nextValue);
                              }}
                              className='w-20 rounded border border-amber-800/50 bg-zinc-900 px-1 py-0.5 text-center text-[10px] text-amber-200 outline-none focus:border-amber-400'
                            />
                          </label>
                          <Button
                            type='button'
                            onClick={() => triggerChannelTake('sceneInstant', 'b')}
                            disabled={isApplyingTakePresetByChannel.sceneInstant}
                            className='w-full rounded border border-amber-800/50 bg-zinc-900 py-1 text-[9px] font-bold tracking-wider text-amber-300 transition hover:bg-amber-900/20 disabled:opacity-50'
                          >
                            TAKE B
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className='mt-2 px-1'>
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
                      className='h-8 w-full rounded border border-violet-900/40 bg-zinc-950 px-2 text-center font-mono text-xs font-bold text-violet-300 outline-none'
                    />
                  </div>
                </div>

                <div className='flex gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-3'>
                  <div className='flex flex-1 overflow-x-auto pb-2 custom-scrollbar'>
                    <div className='flex min-w-max items-stretch gap-5 pr-3'>
                      <MixerStrip
                        title='SONG'
                        widthClass='w-44'
                        stripClassName='rounded-lg border border-zinc-600/50 bg-zinc-800/80 shadow-lg'
                        headerClassName='border-zinc-700 bg-zinc-900'
                        titleClassName='text-zinc-400'
                        muted={mixerLevels.songMuted}
                        solo={mixerLevels.songSolo}
                        onToggleMuted={toggleSongMuted}
                        onToggleSolo={toggleSongSolo}
                        presetAKey={`song-preset-a-${mixerTakePresetsDb.song.aDb}`}
                        presetBKey={`song-preset-b-${mixerTakePresetsDb.song.bDb}`}
                        presetADb={mixerTakePresetsDb.song.aDb}
                        presetBDb={mixerTakePresetsDb.song.bDb}
                        onCommitPresetA={(raw) => commitTakePresetDbInput('song', 'a', raw, mixerTakePresetsDb.song.aDb)}
                        onCommitPresetB={(raw) => commitTakePresetDbInput('song', 'b', raw, mixerTakePresetsDb.song.bDb)}
                        onTakeA={() => triggerChannelTake('song', 'a')}
                        onTakeB={() => triggerChannelTake('song', 'b')}
                        isTakingA={isApplyingTakePresetByChannel.song}
                        isTakingB={isApplyingTakePresetByChannel.song}
                        levelKey={`song-level-${mixerLevels.songMasterVolume}`}
                        levelValue={mixerLevels.songMasterVolume}
                        levelAriaLabel='Song channel level in dB'
                        onCommitLevel={(raw) => {
                          const nextValue = parseMixerLevelInputToFader(raw, mixerLevels.songMasterVolume);
                          setSongMasterVolume(nextValue);
                          return nextValue;
                        }}
                        levelContainerClassName='border-[#1a3525] bg-[#0a1510]'
                        levelInputClassName='w-full bg-transparent px-2 text-center font-mono text-sm font-bold text-emerald-500 outline-none'
                        liveClassName='text-emerald-700'
                        isLive={songOutputGain > 0}
                        meterFill={songMeterFill}
                        meterPeakFill={songPeakFill}
                        meterPeakHoldFill={songPeakHoldFill}
                        markerA={songPresetAFader}
                        markerB={songPresetBFader}
                        markerBorderClassName='border-sky-300/90'
                        markerTextClassName='text-sky-300'
                        markerTrackClassName='w-8'
                      />

                      {shouldShowStreamStrip ? (
                        <MixerStrip
                          title='STREAM'
                          widthClass='w-44'
                          stripClassName='rounded-lg border border-cyan-700/40 bg-zinc-800/80 shadow-lg'
                          headerClassName='border-cyan-900/60 bg-cyan-950/20'
                          titleClassName='text-violet-300'
                          muted={mixerLevels.streamMuted}
                          solo={mixerLevels.streamSolo}
                          onToggleMuted={toggleStreamMuted}
                          onToggleSolo={toggleStreamSolo}
                          presetAKey={`stream-preset-a-${mixerTakePresetsDb.stream.aDb}`}
                          presetBKey={`stream-preset-b-${mixerTakePresetsDb.stream.bDb}`}
                          presetADb={mixerTakePresetsDb.stream.aDb}
                          presetBDb={mixerTakePresetsDb.stream.bDb}
                          onCommitPresetA={(raw) => commitTakePresetDbInput('stream', 'a', raw, mixerTakePresetsDb.stream.aDb)}
                          onCommitPresetB={(raw) => commitTakePresetDbInput('stream', 'b', raw, mixerTakePresetsDb.stream.bDb)}
                          onTakeA={() => triggerChannelTake('stream', 'a')}
                          onTakeB={() => triggerChannelTake('stream', 'b')}
                          isTakingA={isApplyingTakePresetByChannel.stream}
                          isTakingB={isApplyingTakePresetByChannel.stream}
                          levelKey={`stream-level-${mixerLevels.streamMasterVolume}`}
                          levelValue={mixerLevels.streamMasterVolume}
                          levelAriaLabel='Stream channel level in dB'
                          onCommitLevel={(raw) => {
                            const nextValue = parseMixerLevelInputToFader(raw, mixerLevels.streamMasterVolume);
                            setStreamMasterVolume(nextValue);
                            return nextValue;
                          }}
                          levelContainerClassName='border-cyan-900/30 bg-[#07161a]'
                          levelInputClassName='w-full bg-transparent px-2 text-center font-mono text-sm font-bold text-sky-300 outline-none'
                          liveClassName='text-sky-300'
                          isLive={streamOutputGain > 0}
                          showMeterSignal={false}
                          markerA={streamPresetAFader}
                          markerB={streamPresetBFader}
                          markerBorderClassName='border-sky-300/90'
                          markerTextClassName='text-sky-300'
                          markerTrackClassName='w-8'
                        />
                      ) : null}

                      <MixerStrip
                        title='INSTANTS'
                        widthClass='w-44'
                        stripClassName='rounded-lg border border-zinc-600/50 bg-zinc-800/80 shadow-lg'
                        headerClassName='border-zinc-700 bg-zinc-900'
                        titleClassName='text-zinc-400'
                        muted={mixerLevels.instantMuted}
                        solo={mixerLevels.instantSolo}
                        onToggleMuted={toggleInstantMuted}
                        onToggleSolo={toggleInstantSolo}
                        presetAKey={`instants-preset-a-${mixerTakePresetsDb.instants.aDb}`}
                        presetBKey={`instants-preset-b-${mixerTakePresetsDb.instants.bDb}`}
                        presetADb={mixerTakePresetsDb.instants.aDb}
                        presetBDb={mixerTakePresetsDb.instants.bDb}
                        onCommitPresetA={(raw) => commitTakePresetDbInput('instants', 'a', raw, mixerTakePresetsDb.instants.aDb)}
                        onCommitPresetB={(raw) => commitTakePresetDbInput('instants', 'b', raw, mixerTakePresetsDb.instants.bDb)}
                        onTakeA={() => triggerChannelTake('instants', 'a')}
                        onTakeB={() => triggerChannelTake('instants', 'b')}
                        isTakingA={isApplyingTakePresetByChannel.instants}
                        isTakingB={isApplyingTakePresetByChannel.instants}
                        levelKey={`instants-level-${mixerLevels.instantMasterVolume}`}
                        levelValue={mixerLevels.instantMasterVolume}
                        levelAriaLabel='Instants channel level in dB'
                        onCommitLevel={(raw) => {
                          const nextValue = parseMixerLevelInputToFader(raw, mixerLevels.instantMasterVolume);
                          setInstantMasterVolume(nextValue);
                          return nextValue;
                        }}
                        levelContainerClassName='border-[#1a3525] bg-[#0a1510]'
                        levelInputClassName='w-full bg-transparent px-2 text-center font-mono text-sm font-bold text-emerald-500 outline-none'
                        liveClassName='text-emerald-700'
                        isLive={instantsOutputGain > 0}
                        meterFill={instantsMeterFill}
                        meterPeakFill={instantsPeakFill}
                        meterPeakHoldFill={instantsPeakHoldFill}
                        markerA={instantsPresetAFader}
                        markerB={instantsPresetBFader}
                        markerBorderClassName='border-sky-300/90'
                        markerTextClassName='text-sky-300'
                        markerTrackClassName='w-8'
                      />
                    </div>
                  </div>

                  <MixerStrip
                    title='MAIN MIX'
                    widthClass='w-48'
                    stripClassName='rounded-lg border border-red-700/40 bg-zinc-800 shadow-xl'
                    headerClassName='border-red-900/50 bg-red-950/20'
                    titleClassName='text-red-500'
                    showMuteSolo={false}
                    showPresets={false}
                    presetAKey={`main-preset-a-${mixerTakePresetsDb.main.aDb}`}
                    presetBKey={`main-preset-b-${mixerTakePresetsDb.main.bDb}`}
                    presetADb={mixerTakePresetsDb.main.aDb}
                    presetBDb={mixerTakePresetsDb.main.bDb}
                    onCommitPresetA={(raw) => commitTakePresetDbInput('main', 'a', raw, mixerTakePresetsDb.main.aDb)}
                    onCommitPresetB={(raw) => commitTakePresetDbInput('main', 'b', raw, mixerTakePresetsDb.main.bDb)}
                    onTakeA={() => triggerChannelTake('main', 'a')}
                    onTakeB={() => triggerChannelTake('main', 'b')}
                    isTakingA={isApplyingTakePresetByChannel.main}
                    isTakingB={isApplyingTakePresetByChannel.main}
                    topPanel={
                      <div className='flex flex-col gap-1 rounded border border-red-900/20 bg-zinc-900/50 px-2 py-1.5 shadow-inner'>
                        <label className='text-[10px] font-mono text-red-300'>
                          <span className='block text-center'>TAKE FADE (ms)</span>
                          <Input
                            type='number'
                            step={100}
                            min={0}
                            max={20000}
                            value={takePresetFadeMs}
                            onChange={(event) => setTakePresetFadeMs(normalizeTakeVolumeFadeMs(Number(event.target.value), takePresetFadeMs))}
                            className='w-full rounded border border-red-900/50 bg-zinc-900 px-1 py-0.5 text-center text-[10px] text-red-200 outline-none focus:border-red-400'
                          />
                        </label>
                      </div>
                    }
                    levelKey={`main-level-${mixerLevels.mainMasterVolume}`}
                    levelValue={mixerLevels.mainMasterVolume}
                    levelAriaLabel='Main mix level in dB'
                    onCommitLevel={(raw) => {
                      const nextValue = parseMixerLevelInputToFader(raw, mixerLevels.mainMasterVolume);
                      setMainMasterVolume(nextValue);
                      return nextValue;
                    }}
                    levelContainerClassName='border-red-950/50 bg-[#1a0a0a]'
                    levelInputClassName='w-full bg-transparent px-2 text-center font-mono text-sm font-bold text-red-300 outline-none'
                    liveClassName='text-red-700'
                    isLive={mainMixGain > 0}
                    meterFill={mainMixMeterFill}
                    meterPeakFill={mainMixPeakFill}
                    meterPeakHoldFill={mainMixPeakHoldFill}
                    meterBarCount={2}
                    combineMarkerRail={true}
                    markerA={mainPresetAFader}
                    markerB={mainPresetBFader}
                    markerBorderClassName='border-sky-300/90'
                    markerTextClassName='text-sky-300'
                    showMarkerLabels={false}
                    combinedMarkerLineClassName='w-6'
                    markerTrackClassName='w-8'
                    scalePositiveClassName='text-red-400'
                  />
                </div>
              </div>
            </Panel>

            <Panel title='Stage Attributes' accent='#14b8a6' variant='monitor' className='min-h-0' grow>
              <SceneAttributesPanel
                selectedScene={selectedScene}
                scenes={scenes}
                stagedIsOnAir={stagedIsOnAir}
                isSavingSceneAttributes={isSavingSceneAttributes}
                sceneAttributeSaveError={sceneAttributeSaveError}
                editableSceneComponentEntries={editableSceneComponentEntries}
                componentTypes={componentTypes}
                sceneEditorProps={sceneEditorProps}
                selectedSceneInstantId={selectedSceneInstantId}
                selectedSceneInstant={selectedSceneInstant}
                sceneInstantPlayback={sceneInstantPlayback}
                activeProgramId={activeProgramId}
                instants={instants}
                songCatalog={songCatalog}
                mediaGroups={mediaGroups}
                isLoadingMediaGroups={isLoadingMediaGroups}
                onBlurCapture={(event) => {
                  if (selectedSceneRef.current !== null) {
                    void flushSceneAttributeAutosaveForScene(selectedSceneRef.current).catch(() => {});
                  }
                }}
                onSave={() => void saveStagedSceneAttributes()}
                onCommitComponentProps={(componentType, props) => commitSceneEditorComponentProps(componentType, props)}
                onUpdateProp={updateSceneEditorProp}
                onReplaceProps={replaceSceneEditorComponentProps}
                onTakeSceneInstant={(sceneId, instantId) => takeSceneInstant(sceneId, instantId)}
                onStopSceneInstant={() => stopSceneInstant()}
              />
            </Panel>
          </PanelColumn>

          <PanelColumn style={{ width: 520, minWidth: 520 }}>
            <Panel
              title='Playlist'
              accent='#8b5cf6'
              variant='monitor'
              className='min-h-0'
              grow
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
              <PlaylistPanel
                sequence={programAudioBusSongSequence}
                songCatalog={songCatalog}
                programSongPlayback={programSongPlaybackState}
                onChange={(nextSequence) => {
                  void saveProgramAudioBusSongSequence(nextSequence);
                }}
                onTakeSelection={async (nextSequence) => {
                  await saveProgramAudioBusSongSequence(nextSequence);
                }}
              />
            </Panel>
            <Panel
              title='Instants'
              accent='#f59e0b'
              variant='monitor'
              className='min-h-0'
              grow
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
              <InstantsPanel
                isLoading={isLoadingInstants}
                instants={instants}
                search={instantSearch}
                playback={instantPlayback}
                onSearchChange={setInstantSearch}
                onTrigger={(id) => void triggerInstant(id)}
              />
            </Panel>
          </PanelColumn>
        </PanelLayout>
      </div>
      <div className='relative z-20 shrink-0'>
        <PlaybackBar
          sequence={programAudioBusSongSequence}
          programSongPlayback={programSongPlaybackState}
          sceneQuickActions={sceneQuickActions}
          onChange={(nextSequence) => {
            void saveProgramAudioBusSongSequence(nextSequence);
          }}
          onTakeSelection={async (nextSequence) => {
            await saveProgramAudioBusSongSequence(nextSequence);
          }}
          onTakeOffAir={async () => {
            await takeProgramSongOffAir();
          }}
          onStopAllInstants={() => {
            void stopAllInstants();
          }}
          onStageScene={(sceneId) => {
            void stageSceneForProgram(sceneId);
          }}
          onTakeScene={(sceneId) => {
            void activateScene(sceneId);
          }}
        />
      </div>
      <PlaylistSheetPanel
        isOpen={isPlaylistSheetOpen}
        onClose={() => setIsPlaylistSheetOpen(false)}
        sequence={programAudioBusSongSequence}
        songCatalog={songCatalog}
        programSongPlayback={programSongPlaybackState}
        isSaving={isSavingProgramAudioBus}
        onChange={(nextSequence) => {
          void saveProgramAudioBusSongSequence(nextSequence);
        }}
        onTakeSelection={async (nextSequence) => {
          await saveProgramAudioBusSongSequence(nextSequence);
        }}
      />
    </div>
  );
}
