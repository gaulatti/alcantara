import {
  Button,
  Input,
  LoadingSpinner,
} from "@gaulatti/bleecker";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSSE, type SSEConnectionState } from "../hooks/useSSE";
import {
  OVERLAY_COMPONENTS,
  getDefaultPropsForComponent as getStaticDefaultProps,
  hasConfigurableSceneAttributes,
} from "../models/components";
import { apiUrl } from "../utils/apiBaseUrl";
import { authFetch } from "../services/api";
import { runSceneSaveDrain } from "../utils/sceneSaveDrain";
import { activateScene as requestSceneTake } from "../services/program";
import { fetchAllMediaLabels } from "../services/mediaLabels";
import { normalizeProgramSongQueue } from "../utils/songQueue";
import { dbToFader } from "../utils/audioTaper";
import { useGlobalProgramId } from "../utils/globalProgram";
import { useGlobalTransitionId } from "../utils/globalTransition";
import { getProgramRealtimeSocketUrl } from "../utils/programRealtimeSocket";
import {
  acceptStageSceneResponse,
  type StageSceneResponse,
} from "../utils/stageSceneResponse";
import {
  createProgramSongSequence,
  createProgramTextSequence,
  normalizeProgramSongSequence,
  type ProgramSongSequence,
  type ProgramSongSequenceItem,
} from "../utils/programSequence";
import type { Route } from "./+types/control";

import { PlaybackBar } from "../components/PlaybackBar";
import { TvAudioWorkspace, type TvAudioChannel } from "../components/TvAudioWorkspace";
import { BroadcastSwitcherDeck } from "../components/BroadcastSwitcherDeck";
import { useConsolePreferences } from "../contexts/ConsolePreferencesContext";
import { RadioPanel } from "../components/RadioPanel";
import { RecordingPanel } from "../components/RecordingPanel";
import { SimulcastStatusRail } from "../components/SimulcastStatusRail";
import {
  PlaylistSheetPanel,
  SceneAttributesPanel,
} from "../components/panels";
import type {
  BackgroundAudioAsset,
  BroadcastSettings,
  ComponentPropsMap,
  InstantItem,
  InstantPlaybackState,
  Layout,
  MediaGroup,
  MediaLabel,
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
  SongCatalogItem,
} from "../models/broadcast";
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
  parseSceneMetadata,
  readControlUpdateVersion,
  reconcileProgramAudioMeter,
  reconcileProgramSongOffAir,
  reconcileProgramSongPlayback,
  resolveControlUpdateTopicFromType,
  withIndependentProgramClockMetadata,
  withNormalizedMixerChannels,
} from "../utils/broadcast";

function flattenProgramSongItems(
  items: ProgramSongSequenceItem[],
): Extract<ProgramSongSequenceItem, { kind: "preset" }>[] {
  const flattened: Extract<ProgramSongSequenceItem, { kind: "preset" }>[] = [];
  for (const item of items) {
    if (item.kind === "preset") {
      flattened.push(item);
      continue;
    }
    flattened.push(...flattenProgramSongItems(item.sequence.items));
  }
  return flattened;
}

function normalizeProgramSongPlaylist(
  sequence: ProgramSongSequence,
): ProgramSongSequence {
  const playlistItems = flattenProgramSongItems(sequence.items);
  const activeItemId =
    sequence.activeItemId === null
      ? null
      : sequence.activeItemId &&
          playlistItems.some((item) => item.id === sequence.activeItemId)
        ? sequence.activeItemId
        : (playlistItems[0]?.id ?? null);
  return { ...sequence, items: playlistItems, activeItemId };
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Control Panel - TV Broadcast" },
    {
      name: "description",
      content: "Control panel for TV broadcast overlay system",
    },
  ];
}

export default function Control() {
  const consolePreferences = useConsolePreferences();
  const [activeProgramId] = useGlobalProgramId();
  const activeProgramIdRef = useRef(activeProgramId);
  activeProgramIdRef.current = activeProgramId;
  const [programState, setProgramState] = useState<ProgramState | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [instants, setInstants] = useState<InstantItem[]>([]);
  const [isLoadingInstants, setIsLoadingInstants] = useState(false);
  const [instantSearch, setInstantSearch] = useState("");
  const [songCatalog, setSongCatalog] = useState<SongCatalogItem[]>([]);
  const [mediaGroups, setMediaGroups] = useState<MediaGroup[]>([]);
  const [isLoadingMediaGroups, setIsLoadingMediaGroups] = useState(false);
  const [mediaLabels, setMediaLabels] = useState<MediaLabel[]>([]);
  const [isLoadingMediaLabels, setIsLoadingMediaLabels] = useState(false);
  const [backgroundAudioAssets, setBackgroundAudioAssets] = useState<BackgroundAudioAsset[]>([]);
  const [isLoadingBackgroundAudio, setIsLoadingBackgroundAudio] = useState(false);
  const [instantDurationsMs, setInstantDurationsMs] = useState<
    Record<number, number | null>
  >({});
  const [instantPlayback, setInstantPlayback] = useState<
    Record<number, InstantPlaybackState>
  >({});
  const instantDurationByUrlRef = useRef<Record<string, number | null>>({});
  const instantPlaybackTimeoutsRef = useRef<Record<number, number>>({});
  const [layouts, setLayouts] = useState<Layout[]>([]);
  const componentTypes = OVERLAY_COMPONENTS.map((c) => ({
    type: c.id,
    name: c.name,
    description: c.description,
  }));
  const [selectedScene, setSelectedScene] = useState<number | null>(null);
  const [takeBusy, setTakeBusy] = useState(false);
  const takeInFlightRef = useRef(false);
  const [recordingOpen, setRecordingOpen] = useState(false);
  const [takeError, setTakeError] = useState<string | null>(null);
  useEffect(() => setTakeError(null), [activeProgramId]);
  const [sceneEditorProps, setSceneEditorProps] = useState<Record<string, any>>(
    {},
  );
  const [isSavingSceneAttributes, setIsSavingSceneAttributes] = useState(false);
  const [sceneAttributeSaveError, setSceneAttributeSaveError] = useState<
    string | null
  >(null);
  const sceneEditorAutosaveTimerRef = useRef<number | null>(null);
  const sceneEditorAutosaveSignatureRef = useRef<string>("");
  const sceneEditorDirtyRef = useRef<boolean>(false);
  const sceneEditorRevisionRef = useRef<number>(0);
  const selectedSceneRef = useRef<number | null>(null);
  const previousSelectedSceneRef = useRef<number | null>(null);
  const sceneEditorPropsRef = useRef<ComponentPropsMap>({});
  const sceneMetadataCacheRef = useRef<Record<number, ComponentPropsMap>>({});
  const pendingSceneAttributeSaveRef = useRef<SceneAttributeSavePayload | null>(
    null,
  );
  const sceneAttributeSaveDrainPromiseRef = useRef<Promise<void> | null>(null);
  const sceneAttributeRetryTimerRef = useRef<number | null>(null);
  const sceneAttributeFlushKickTimerRef = useRef<number | null>(null);
  const sceneAttributeRetryDelayMsRef = useRef<number>(800);
  const [editingScene, setEditingScene] = useState<Scene | null>(null);

  const [showSceneModal, setShowSceneModal] = useState(false);
  const [newSceneName, setNewSceneName] = useState("");
  const [selectedLayoutId, setSelectedLayoutId] = useState<number | null>(null);
  const [sceneComponentProps, setSceneComponentProps] = useState<
    Record<string, any>
  >({});
  const [sceneErrors, setSceneErrors] = useState({
    name: "",
    layout: "",
    props: "",
  });
  const [isCreatingScene, setIsCreatingScene] = useState(false);
  const [selectedTransitionId, setSelectedTransitionId] =
    useGlobalTransitionId(activeProgramId);
  const consoleWorkspace = consolePreferences.profile.workspace;
  const [programAudioBusSettings, setProgramAudioBusSettings] =
    useState<ProgramAudioBusSettings>({
      songSequence: createProgramSongSequence("manual"),
      songQueue: [],
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
      streamSolo: false,
    }),
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
      streamSolo: false,
    }),
  });
  const [isLoadingMixerLevels, setIsLoadingMixerLevels] = useState(false);
  const [isSavingMixerLevels, setIsSavingMixerLevels] = useState(false);
  const [mixerSaveError, setMixerSaveError] = useState<string | null>(null);
  const mixerSaveTimeoutRef = useRef<number | null>(null);
  const takeVolumeFadeTimerRef = useRef<MixerTakeTimerMap>({
    ...DEFAULT_MIXER_TAKE_TIMERS,
  });
  const takeVolumeFadeRunIdRef = useRef<MixerTakeRunIdMap>({
    ...DEFAULT_MIXER_TAKE_RUN_IDS,
  });
  const [mixerTakePresetsDb, setMixerTakePresetsDb] =
    useState<MixerTakePresetDbMap>({ ...DEFAULT_MIXER_TAKE_PRESETS_DB });
  const [takePresetFadeMs, setTakePresetFadeMs] = useState<number>(5000);
  const [isApplyingTakePresetByChannel, setIsApplyingTakePresetByChannel] =
    useState<MixerTakeApplyingMap>({ ...DEFAULT_MIXER_TAKE_APPLYING });
  const [programAudioMeterLevels, setProgramAudioMeterLevels] =
    useState<ProgramAudioMeterLevels>({
      song: createEmptyMeterChannel(),
      instants: createEmptyMeterChannel(),
      sceneInstant: createEmptyMeterChannel(),
      main: createEmptyMeterChannel(),
      updatedAt: new Date(0).toISOString(),
    });
  const [programSongPlaybackState, setProgramSongPlaybackState] =
    useState<ProgramSongPlaybackState>({
      token: "",
      audioUrl: "",
      progress: 0,
      currentTimeMs: 0,
      durationMs: null,
      isPlaying: false,
      updatedAt: new Date(0).toISOString(),
    });
  const [sceneInstantPlayback, setSceneInstantPlayback] =
    useState<SceneInstantPlaybackState>({
      sceneId: null,
      instantId: null,
      mediaAssetId: null,
      instantName: "",
      isPlaying: false,
      updatedAt: new Date(0).toISOString(),
    });
  const programRealtimeSocketRef = useRef<WebSocket | null>(null);
  const [programSseConnectionState, setProgramSseConnectionState] =
    useState<SSEConnectionState>("connecting");
  const canUseProgramRealtimeFallback =
    programSseConnectionState === "disconnected";
  const [isProgramRealtimeConnected, setIsProgramRealtimeConnected] =
    useState(false);
  const latestControlVersionByTopicRef = useRef<
    Record<ProgramUpdateTopic, number>
  >({
    state: -1,
    audioBus: -1,
    audioMeter: -1,
    songPlayback: -1,
    sceneInstant: -1,
    flight: -1,
  });

  const applySceneUpdateLocally = useCallback((nextScene: Scene) => {
    if (
      !nextScene ||
      typeof nextScene !== "object" ||
      typeof nextScene.id !== "number"
    ) {
      return;
    }

    sceneMetadataCacheRef.current[nextScene.id] = parseSceneMetadata(
      nextScene.metadata,
    );

    setScenes((previous) => {
      const existingIndex = previous.findIndex(
        (scene) => scene.id === nextScene.id,
      );
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
          scene: nextScene,
        };
      });

      const nextActiveScene =
        previous.activeScene?.id === nextScene.id
          ? nextScene
          : previous.activeScene;
      const nextStagedScene =
        previous.stagedScene?.id === nextScene.id
          ? nextScene
          : previous.stagedScene;
      const didUpdateHeader =
        nextActiveScene !== previous.activeScene ||
        nextStagedScene !== previous.stagedScene;

      if (!didUpdateSceneEntry && !didUpdateHeader) {
        return previous;
      }

      return {
        ...previous,
        scenes: didUpdateSceneEntry ? nextEntries : previous.scenes,
        activeScene: nextActiveScene,
        stagedScene: nextStagedScene,
      };
    });
  }, []);

  const shouldApplyControlUpdatePayload = useCallback(
    (payload: unknown, topicOverride?: ProgramUpdateTopic): boolean => {
      const topic =
        topicOverride ??
        (payload && typeof payload === "object" && !Array.isArray(payload)
          ? resolveControlUpdateTopicFromType(
              (payload as Record<string, unknown>).type,
            )
          : null);
      if (!topic) {
        return true;
      }

      const nextVersion = readControlUpdateVersion(topic, payload);
      if (nextVersion === null) {
        return true;
      }

      const previousVersion =
        latestControlVersionByTopicRef.current[topic] ?? -1;
      if (nextVersion <= previousVersion) {
        return false;
      }

      latestControlVersionByTopicRef.current[topic] = nextVersion;
      return true;
    },
    [],
  );

  useEffect(() => {
    fetchScenes();
    fetchLayouts();
    fetchComponentTypes();
    fetchSongCatalog();
  }, []);

  useEffect(() => {
    setProgramState(null);
    setSelectedScene(null);
    latestControlVersionByTopicRef.current = {
      state: -1,
      audioBus: -1,
      audioMeter: -1,
      songPlayback: -1,
      sceneInstant: -1,
      flight: -1,
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
      updatedAt: new Date(0).toISOString(),
    });
    setProgramSongPlaybackState({
      token: "",
      audioUrl: "",
      progress: 0,
      currentTimeMs: 0,
      durationMs: null,
      isPlaying: false,
      updatedAt: new Date(0).toISOString(),
    });
    setSceneInstantPlayback({
      sceneId: null,
      instantId: null,
      mediaAssetId: null,
      instantName: "",
      isPlaying: false,
      updatedAt: new Date(0).toISOString(),
    });
    void fetchMediaGroups(activeProgramId);
    void fetchMediaLabels();
    void fetchBackgroundAudioAssets();
    void fetchProgramState(activeProgramId);
    void fetchProgramAudioBusSettings(activeProgramId);
    void fetchProgramAudioMeter(activeProgramId);
    void fetchProgramSongPlayback(activeProgramId);
    void fetchSceneInstantPlayback(activeProgramId);
  }, [activeProgramId]);

  useEffect(() => {
    if (!canUseProgramRealtimeFallback || isProgramRealtimeConnected) {
      return;
    }

    let cancelled = false;
    const fallbackTimer = window.setTimeout(() => {
      if (
        cancelled ||
        !canUseProgramRealtimeFallback ||
        programRealtimeSocketRef.current?.readyState === WebSocket.OPEN
      ) {
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
  }, [
    activeProgramId,
    canUseProgramRealtimeFallback,
    isProgramRealtimeConnected,
  ]);

  useEffect(() => {
    if (!canUseProgramRealtimeFallback || isProgramRealtimeConnected) {
      return;
    }
    const resyncInterval = window.setInterval(() => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }

      void fetchProgramState(activeProgramId);
      void fetchProgramAudioBusSettings(activeProgramId, false);
      void fetchProgramAudioMeter(activeProgramId);
      void fetchProgramSongPlayback(activeProgramId);
      void fetchSceneInstantPlayback(activeProgramId);
    }, 5000);

    return () => {
      window.clearInterval(resyncInterval);
    };
  }, [
    activeProgramId,
    canUseProgramRealtimeFallback,
    isProgramRealtimeConnected,
  ]);

  useEffect(() => {
    mixerLevelsRef.current = mixerLevels;
  }, [mixerLevels]);

  useEffect(() => {
    selectedSceneRef.current = selectedScene;
  }, [selectedScene]);

  useEffect(() => {
    sceneEditorPropsRef.current = sceneEditorProps;
  }, [sceneEditorProps]);

  const syncProgramStateAndStagedScene = useCallback(
    (nextProgramState: ProgramState | null) => {
      setProgramState(nextProgramState);
      setSelectedScene(() => {
        if (!nextProgramState) {
          return null;
        }

        const nextStagedSceneId =
          typeof nextProgramState.stagedSceneId === "number" &&
          nextProgramState.scenes.some(
            (entry) => entry.sceneId === nextProgramState.stagedSceneId,
          )
            ? nextProgramState.stagedSceneId
            : null;

        return nextStagedSceneId;
      });
    },
    [],
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (!canUseProgramRealtimeFallback) {
      programRealtimeSocketRef.current?.close();
      programRealtimeSocketRef.current = null;
      setIsProgramRealtimeConnected(false);
      return;
    }

    let disposed = false;
    let reconnectTimer: number | null = null;

    const connect = async () => {
      if (disposed) {
        return;
      }

      let socket: WebSocket;
      try {
        const ticketResponse = await authFetch("/auth/realtime-ticket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ programId: activeProgramId }),
        });
        if (!ticketResponse.ok) {
          throw new Error(`Realtime ticket HTTP ${ticketResponse.status}`);
        }
        const ticketPayload = (await ticketResponse.json()) as {
          ticket?: unknown;
        };
        if (
          disposed ||
          typeof ticketPayload.ticket !== "string" ||
          !ticketPayload.ticket
        ) {
          return;
        }
        socket = new WebSocket(
          getProgramRealtimeSocketUrl(
            activeProgramId,
            "control",
            ticketPayload.ticket,
          ),
        );
      } catch {
        reconnectTimer = window.setTimeout(() => void connect(), 1500);
        return;
      }

      programRealtimeSocketRef.current = socket;
      setIsProgramRealtimeConnected(false);

      socket.addEventListener("open", () => {
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

      socket.addEventListener("message", (event) => {
        if (disposed || activeProgramIdRef.current !== activeProgramId) {
          return;
        }

        let payload: any;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }

        if (!payload || typeof payload !== "object") {
          return;
        }

        if (!shouldApplyControlUpdatePayload(payload)) {
          return;
        }

        if (payload.type === "program_state_snapshot") {
          const eventProgramId =
            typeof payload.programId === "string" ? payload.programId : "";
          if (eventProgramId !== activeProgramId) {
            return;
          }
          const normalizedProgramState = normalizeProgramState(payload.state);
          syncProgramStateAndStagedScene(normalizedProgramState);
          return;
        }

        if (payload.type === "audio_bus_snapshot") {
          const eventProgramId =
            typeof payload.programId === "string" ? payload.programId : "";
          if (eventProgramId !== activeProgramId) {
            return;
          }
          const nextMixerSource =
            payload.settings && typeof payload.settings === "object"
              ? (payload.settings as { mixerSettings?: unknown }).mixerSettings
              : undefined;
          if (nextMixerSource !== undefined) {
            const nextMixerLevels =
              normalizeBroadcastSettingsPayload(nextMixerSource);
            mixerLevelsRef.current = nextMixerLevels;
            setMixerLevels(nextMixerLevels);
          }
          const normalizedSongSequence = normalizeProgramSongPlaylist(
            normalizeProgramSongSequence(payload?.settings?.songSequence) ?? {
              ...createProgramSongSequence("manual"),
              activeItemId: null,
            },
          );
          setProgramAudioBusSettings((previous) => ({
            ...previous,
            songSequence: normalizedSongSequence,
            songQueue: normalizeProgramSongQueue(payload?.settings?.songQueue),
          }));
          return;
        }

        if (payload.type === "scene_staged") {
          const eventProgramId =
            typeof payload.programId === "string" ? payload.programId : "";
          if (eventProgramId !== activeProgramId) {
            return;
          }
          const nextStagedSceneId =
            typeof payload.stagedSceneId === "number"
              ? payload.stagedSceneId
              : null;
          setSelectedScene(nextStagedSceneId);
          setProgramState((previous) => {
            if (!previous) {
              return previous;
            }
            return {
              ...previous,
              stagedSceneId: nextStagedSceneId,
              stagedScene:
                payload.scene && typeof payload.scene === "object"
                  ? (payload.scene as Scene)
                  : null,
            };
          });
          return;
        }

        if (payload.type === "fade_to_black") {
          const normalizedProgramState = normalizeProgramState(payload.state);
          syncProgramStateAndStagedScene(normalizedProgramState);
          return;
        }

        if (
          payload.type === "scene_change" ||
          payload.type === "program_scenes_changed" ||
          payload.type === "program_media_groups_changed"
        ) {
          const eventProgramId =
            typeof payload.programId === "string" ? payload.programId : "";
          if (eventProgramId !== activeProgramId) {
            return;
          }
          const normalizedProgramState = normalizeProgramState(payload.state);
          syncProgramStateAndStagedScene(normalizedProgramState);
          if (payload.type === "program_media_groups_changed") {
            void fetchMediaGroups(activeProgramId);
          }
          return;
        }

        if (payload.type === "scene_update") {
          const eventProgramId =
            typeof payload.programId === "string" ? payload.programId : "";
          if (eventProgramId !== activeProgramId) {
            return;
          }
          if (payload.scene && typeof payload.scene === "object") {
            applySceneUpdateLocally(payload.scene as Scene);
          }
          return;
        }

        if (payload.type === "scene_cleared") {
          const eventProgramId =
            typeof payload.programId === "string" ? payload.programId : "";
          if (eventProgramId !== activeProgramId) {
            return;
          }
          setProgramState((prev) => {
            if (!prev) {
              return prev;
            }
            return {
              ...prev,
              activeSceneId: null,
            };
          });
          return;
        }

        if (payload.type === "audio_bus_update") {
          const eventProgramId =
            typeof payload.programId === "string" ? payload.programId : "";
          if (eventProgramId !== activeProgramId) {
            return;
          }
          const nextMixerSource =
            payload.settings && typeof payload.settings === "object"
              ? (payload.settings as { mixerSettings?: unknown }).mixerSettings
              : undefined;
          if (nextMixerSource !== undefined) {
            const nextMixerLevels =
              normalizeBroadcastSettingsPayload(nextMixerSource);
            mixerLevelsRef.current = nextMixerLevels;
            setMixerLevels(nextMixerLevels);
          }
          const normalizedSongSequence = normalizeProgramSongPlaylist(
            normalizeProgramSongSequence(payload?.settings?.songSequence) ?? {
              ...createProgramSongSequence("manual"),
              activeItemId: null,
            },
          );
          setProgramAudioBusSettings((previous) => ({
            ...previous,
            songSequence: normalizedSongSequence,
            songQueue:
              payload?.settings?.songQueue === undefined
                ? previous.songQueue
                : normalizeProgramSongQueue(payload.settings.songQueue),
          }));
          return;
        }

        if (payload.type === "song_queue_update") {
          const eventProgramId =
            typeof payload.programId === "string" ? payload.programId : "";
          if (eventProgramId !== activeProgramId) return;
          setProgramAudioBusSettings((previous) => ({
            ...previous,
            songQueue: normalizeProgramSongQueue(payload.songQueue),
            songSequence:
              payload.songSequence === undefined
                ? previous.songSequence
                : normalizeProgramSongPlaylist(
                    normalizeProgramSongSequence(payload.songSequence) ?? {
                      ...createProgramSongSequence("manual"),
                      activeItemId: null,
                    },
                  ),
          }));
          return;
        }

        if (payload.type === "audio_meter_update") {
          const eventProgramId =
            typeof payload.programId === "string" ? payload.programId : "";
          if (eventProgramId !== activeProgramId) {
            return;
          }
          setProgramAudioMeterLevels((previous) =>
            reconcileProgramAudioMeter(
              previous,
              normalizeProgramAudioMeter(payload.levels),
            ),
          );
          return;
        }

        if (payload.type === "song_playback_update") {
          const eventProgramId =
            typeof payload.programId === "string" ? payload.programId : "";
          if (eventProgramId !== activeProgramId) {
            return;
          }
          setProgramSongPlaybackState((previous) =>
            reconcileProgramSongPlayback(
              previous,
              normalizeProgramSongPlayback(payload.playback),
            ),
          );
          return;
        }

        if (payload.type === "song_off_air") {
          const eventProgramId =
            typeof payload.programId === "string" ? payload.programId : "";
          if (eventProgramId !== activeProgramId) {
            return;
          }
          setProgramSongPlaybackState((previous) =>
            reconcileProgramSongOffAir(
              previous,
              payload.playback,
              payload.triggeredAt,
            ),
          );
          return;
        }

        if (payload.type === "scene_instant_state") {
          const eventProgramId =
            typeof payload.programId === "string" ? payload.programId : "";
          if (eventProgramId !== activeProgramId) {
            return;
          }
          setSceneInstantPlayback(
            normalizeSceneInstantPlayback(payload.playback),
          );
          return;
        }

        if (payload.type === "scene_instant_take") {
          const eventProgramId =
            typeof payload.programId === "string" ? payload.programId : "";
          if (eventProgramId !== activeProgramId) {
            return;
          }
          setSceneInstantPlayback({
            sceneId: normalizeSceneInstantId(payload.sceneId),
            instantId: normalizeSceneInstantId(payload.instant?.id),
            mediaAssetId:
              typeof payload.instant?.assetId === "string" && payload.instant.assetId.trim()
                ? payload.instant.assetId.trim()
                : null,
            instantName:
              typeof payload.instant?.name === "string"
                ? payload.instant.name
                : "",
            isPlaying: true,
            updatedAt:
              typeof payload.triggeredAt === "string"
                ? payload.triggeredAt
                : new Date().toISOString(),
          });
          return;
        }

        if (payload.type === "scene_instant_stop") {
          const eventProgramId =
            typeof payload.programId === "string" ? payload.programId : "";
          if (eventProgramId !== activeProgramId) {
            return;
          }
          setSceneInstantPlayback((previous) => ({
            ...previous,
            isPlaying: false,
            updatedAt:
              typeof payload.triggeredAt === "string"
                ? payload.triggeredAt
                : new Date().toISOString(),
          }));
        }
      });

      socket.addEventListener("close", () => {
        if (programRealtimeSocketRef.current === socket) {
          programRealtimeSocketRef.current = null;
        }
        setIsProgramRealtimeConnected(false);
        if (!disposed) {
          reconnectTimer = window.setTimeout(() => void connect(), 1500);
        }
      });

      socket.addEventListener("error", () => {
        try {
          socket.close();
        } catch {
          // no-op
        }
      });
    };

    void connect();

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
  }, [
    activeProgramId,
    applySceneUpdateLocally,
    canUseProgramRealtimeFallback,
    shouldApplyControlUpdatePayload,
    syncProgramStateAndStagedScene,
  ]);

  const fetchScenes = async () => {
    try {
      const res = await fetch(apiUrl("/scenes"));
      const data = await res.json();
      setScenes(data);
    } catch (err) {
      console.error("Failed to fetch scenes:", err);
    }
  };

  const fetchLayouts = async () => {
    try {
      const res = await fetch(apiUrl("/layouts"));
      const data = await res.json();
      setLayouts(data);
    } catch (err) {
      console.error("Failed to fetch layouts:", err);
    }
  };

  const fetchComponentTypes = async () => {
    // No-op, using constants
  };

  const fetchInstants = async () => {
    try {
      setIsLoadingInstants(true);
      const res = await fetch(apiUrl("/instants"));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as InstantItem[];
      setInstants(data);
    } catch (err) {
      console.error("Failed to fetch instants:", err);
      setInstants([]);
    } finally {
      setIsLoadingInstants(false);
    }
  };

  const fetchSongCatalog = async () => {
    try {
      const res = await fetch(apiUrl("/songs?limit=0"));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as PaginatedResponse<SongCatalogItem>;
      setSongCatalog(Array.isArray(body.data) ? body.data : []);
    } catch (err) {
      console.error("Failed to fetch songs catalog:", err);
      setSongCatalog([]);
    }
  };

  const fetchMediaGroups = async (
    targetProgramId: string = activeProgramId,
  ) => {
    try {
      setIsLoadingMediaGroups(true);
      const res = await fetch(
        apiUrl(`/program/${encodeURIComponent(targetProgramId)}/media-groups`),
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as MediaGroup[];
      if (targetProgramId !== activeProgramIdRef.current) {
        return;
      }
      setMediaGroups(Array.isArray(data) ? data : []);
    } catch (err) {
      if (targetProgramId !== activeProgramIdRef.current) {
        return;
      }
      console.error("Failed to fetch media groups:", err);
      setMediaGroups([]);
    } finally {
      setIsLoadingMediaGroups(false);
    }
  };

  const fetchMediaLabels = async () => {
    try {
      setIsLoadingMediaLabels(true);
      setMediaLabels(await fetchAllMediaLabels<MediaLabel>());
    } catch (err) {
      console.error('Failed to fetch media labels:', err);
      setMediaLabels([]);
    } finally {
      setIsLoadingMediaLabels(false);
    }
  };

  const fetchBackgroundAudioAssets = async () => {
    try {
      setIsLoadingBackgroundAudio(true);
      const res = await authFetch('/media-assets?mediaType=AUDIO&capability=BACKGROUND&limit=200');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as PaginatedResponse<BackgroundAudioAsset>;
      setBackgroundAudioAssets(Array.isArray(body.data) ? body.data : []);
    } catch (err) {
      console.error('Failed to fetch background audio:', err);
      setBackgroundAudioAssets([]);
    } finally {
      setIsLoadingBackgroundAudio(false);
    }
  };

  const persistMixerLevels = async (nextMixerLevels: BroadcastSettings) => {
    setIsSavingMixerLevels(true);
    setMixerSaveError(null);
    try {
      const res = await fetch(
        apiUrl(`/program/${encodeURIComponent(activeProgramId)}/audio-bus`),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mixerSettings: {
              mainMasterVolume: nextMixerLevels.mainMasterVolume,
              mixerChannels: nextMixerLevels.mixerChannels,
            },
          }),
        },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const payload = (await res.json()) as ProgramAudioBusSettings | null;
      if (!shouldApplyControlUpdatePayload(payload, "audioBus")) {
        return;
      }
      const persistedMixerLevels = normalizeBroadcastSettingsPayload(
        payload?.mixerSettings ?? nextMixerLevels,
      );
      mixerLevelsRef.current = persistedMixerLevels;
      setMixerLevels(persistedMixerLevels);
    } catch (err) {
      console.error("Failed to save mixer levels:", err);
      setMixerSaveError("Mixer change was not applied to Palazzo. Try again.");
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
      songMasterVolume: normalizeMasterVolume(
        nextValue,
        currentMixerLevels.songMasterVolume,
      ),
    };
    commitMixerLevels(nextMixerLevels);
  };

  const setMainMasterVolume = (nextValue: number) => {
    const currentMixerLevels = mixerLevelsRef.current;
    const nextMixerLevels = {
      ...currentMixerLevels,
      mainMasterVolume: normalizeMasterVolume(
        nextValue,
        currentMixerLevels.mainMasterVolume,
      ),
    };
    commitMixerLevels(nextMixerLevels);
  };

  const setInstantMasterVolume = (nextValue: number) => {
    const currentMixerLevels = mixerLevelsRef.current;
    const nextMixerLevels = {
      ...currentMixerLevels,
      instantMasterVolume: normalizeMasterVolume(
        nextValue,
        currentMixerLevels.instantMasterVolume,
      ),
    };
    commitMixerLevels(nextMixerLevels);
  };

  const setSceneInstantMasterVolume = (nextValue: number) => {
    const currentMixerLevels = mixerLevelsRef.current;
    const nextMixerLevels = {
      ...currentMixerLevels,
      sceneInstantMasterVolume: normalizeMasterVolume(
        nextValue,
        currentMixerLevels.sceneInstantMasterVolume,
      ),
    };
    commitMixerLevels(nextMixerLevels);
  };

  const setStreamMasterVolume = (nextValue: number) => {
    const currentMixerLevels = mixerLevelsRef.current;
    const nextMixerLevels = {
      ...currentMixerLevels,
      streamMasterVolume: normalizeMasterVolume(
        nextValue,
        currentMixerLevels.streamMasterVolume,
      ),
    };
    commitMixerLevels(nextMixerLevels);
  };

  const getChannelMasterVolume = (
    mixerState: BroadcastSettings,
    channelId: MixerTakeChannelKey,
  ): number => {
    switch (channelId) {
      case "song":
        return mixerState.songMasterVolume;
      case "stream":
        return mixerState.streamMasterVolume;
      case "instants":
        return mixerState.instantMasterVolume;
      case "sceneInstant":
        return mixerState.sceneInstantMasterVolume;
      case "main":
      default:
        return mixerState.mainMasterVolume;
    }
  };

  const setChannelMasterVolume = (
    channelId: MixerTakeChannelKey,
    nextValue: number,
  ) => {
    switch (channelId) {
      case "song":
        setSongMasterVolume(nextValue);
        return;
      case "stream":
        setStreamMasterVolume(nextValue);
        return;
      case "instants":
        setInstantMasterVolume(nextValue);
        return;
      case "sceneInstant":
        setSceneInstantMasterVolume(nextValue);
        return;
      case "main":
      default:
        setMainMasterVolume(nextValue);
    }
  };

  const updateChannelTakePresetDb = (
    channelId: MixerTakeChannelKey,
    presetSide: MixerTakePresetSide,
    rawValue: number,
  ) => {
    setMixerTakePresetsDb((prev) => {
      const next = { ...prev };
      const key = presetSide === "a" ? "aDb" : "bDb";
      const fallback = next[channelId][key];
      next[channelId] = {
        ...next[channelId],
        [key]: normalizeTakeVolumePresetDb(rawValue, fallback),
      };
      return next;
    });
  };

  const commitTakePresetDbInput = (
    channelId: MixerTakeChannelKey,
    presetSide: MixerTakePresetSide,
    rawValue: string,
    fallbackValue: number,
  ): number => {
    const parsed = Number.parseFloat(rawValue.trim());
    const nextValue = Number.isFinite(parsed)
      ? normalizeTakeVolumePresetDb(parsed, fallbackValue)
      : fallbackValue;
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

  const applyTakePresetToChannel = (
    channelId: MixerTakeChannelKey,
    presetSide: MixerTakePresetSide,
    fadeMs: number = takePresetFadeMs,
  ) => {
    const preset = mixerTakePresetsDb[channelId];
    const presetDb = presetSide === "a" ? preset.aDb : preset.bDb;
    const normalizedPresetDb = normalizeTakeVolumePresetDb(presetDb, -15);
    const normalizedFadeMs = normalizeTakeVolumeFadeMs(fadeMs, 0);
    const currentFader = getChannelMasterVolume(
      mixerLevelsRef.current,
      channelId,
    );
    const targetFader = normalizeMasterVolume(
      dbToFader(normalizedPresetDb),
      currentFader,
    );

    clearTakeVolumeFadeTimer(channelId);
    takeVolumeFadeRunIdRef.current[channelId] += 1;
    const runId = takeVolumeFadeRunIdRef.current[channelId];

    if (
      Math.abs(targetFader - currentFader) <= 0.0001 ||
      normalizedFadeMs <= 0
    ) {
      setChannelMasterVolume(channelId, targetFader);
      setIsApplyingTakePresetByChannel((prev) => ({
        ...prev,
        [channelId]: false,
      }));
      return;
    }

    setIsApplyingTakePresetByChannel((prev) => ({
      ...prev,
      [channelId]: true,
    }));
    const stepIntervalMs = TAKE_VOLUME_PRESET_FADE_STEP_MIN_MS;
    const stepCount = Math.max(1, Math.ceil(normalizedFadeMs / stepIntervalMs));
    let step = 0;

    const advanceStep = () => {
      if (runId !== takeVolumeFadeRunIdRef.current[channelId]) {
        return;
      }

      step += 1;
      const ratio = Math.min(1, step / stepCount);
      const easedRatio =
        ratio < 0.3
          ? (1 - (1 - ratio / 0.3) ** 2) * 0.65
          : 0.65 + ((ratio - 0.3) / 0.7) * 0.35;
      const nextFader =
        currentFader + (targetFader - currentFader) * easedRatio;
      setChannelMasterVolume(channelId, Number(nextFader.toFixed(4)));

      if (ratio >= 1) {
        clearTakeVolumeFadeTimer(channelId);
        if (runId === takeVolumeFadeRunIdRef.current[channelId]) {
          setIsApplyingTakePresetByChannel((prev) => ({
            ...prev,
            [channelId]: false,
          }));
        }
      }
    };

    advanceStep();
    if (step >= stepCount) {
      return;
    }

    takeVolumeFadeTimerRef.current[channelId] = window.setInterval(
      advanceStep,
      stepIntervalMs,
    );
  };

  const triggerChannelTake = (
    channelId: MixerTakeChannelKey,
    presetSide: MixerTakePresetSide,
  ) => {
    applyTakePresetToChannel(channelId, presetSide, takePresetFadeMs);
  };

  const toggleSongMuted = () => {
    const currentMixerLevels = mixerLevelsRef.current;
    commitMixerLevels({
      ...currentMixerLevels,
      songMuted: !currentMixerLevels.songMuted,
    });
  };

  const toggleInstantMuted = () => {
    const currentMixerLevels = mixerLevelsRef.current;
    commitMixerLevels({
      ...currentMixerLevels,
      instantMuted: !currentMixerLevels.instantMuted,
    });
  };

  const toggleStreamMuted = () => {
    const currentMixerLevels = mixerLevelsRef.current;
    commitMixerLevels({
      ...currentMixerLevels,
      streamMuted: !currentMixerLevels.streamMuted,
    });
  };

  const toggleSceneInstantMuted = () => {
    const currentMixerLevels = mixerLevelsRef.current;
    commitMixerLevels({
      ...currentMixerLevels,
      sceneInstantMuted: !currentMixerLevels.sceneInstantMuted,
    });
  };

  const toggleSongSolo = () => {
    const currentMixerLevels = mixerLevelsRef.current;
    commitMixerLevels({
      ...currentMixerLevels,
      songSolo: !currentMixerLevels.songSolo,
    });
  };

  const toggleInstantSolo = () => {
    const currentMixerLevels = mixerLevelsRef.current;
    commitMixerLevels({
      ...currentMixerLevels,
      instantSolo: !currentMixerLevels.instantSolo,
    });
  };

  const toggleStreamSolo = () => {
    const currentMixerLevels = mixerLevelsRef.current;
    commitMixerLevels({
      ...currentMixerLevels,
      streamSolo: !currentMixerLevels.streamSolo,
    });
  };

  const toggleSceneInstantSolo = () => {
    const currentMixerLevels = mixerLevelsRef.current;
    commitMixerLevels({
      ...currentMixerLevels,
      sceneInstantSolo: !currentMixerLevels.sceneInstantSolo,
    });
  };

  const fetchProgramAudioMeter = async (targetProgramId: string) => {
    try {
      const res = await fetch(
        apiUrl(`/program/${encodeURIComponent(targetProgramId)}/audio-meter`),
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const payload = await res.json();
      if (targetProgramId !== activeProgramIdRef.current) {
        return;
      }
      if (!shouldApplyControlUpdatePayload(payload, "audioMeter")) {
        return;
      }
      setProgramAudioMeterLevels(normalizeProgramAudioMeter(payload));
    } catch (err) {
      if (targetProgramId !== activeProgramIdRef.current) {
        return;
      }
      console.error("Failed to fetch program audio meter levels:", err);
      setProgramAudioMeterLevels({
        song: createEmptyMeterChannel(),
        instants: createEmptyMeterChannel(),
        sceneInstant: createEmptyMeterChannel(),
        main: createEmptyMeterChannel(),
        updatedAt: new Date(0).toISOString(),
      });
    }
  };

  const fetchProgramSongPlayback = async (targetProgramId: string) => {
    try {
      const res = await fetch(
        apiUrl(`/program/${encodeURIComponent(targetProgramId)}/song-playback`),
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const payload = await res.json();
      if (targetProgramId !== activeProgramIdRef.current) {
        return;
      }
      if (!shouldApplyControlUpdatePayload(payload, "songPlayback")) {
        return;
      }
      setProgramSongPlaybackState(normalizeProgramSongPlayback(payload));
    } catch (err) {
      if (targetProgramId !== activeProgramIdRef.current) {
        return;
      }
      console.error("Failed to fetch program song playback:", err);
      setProgramSongPlaybackState({
        token: "",
        audioUrl: "",
        progress: 0,
        currentTimeMs: 0,
        durationMs: null,
        isPlaying: false,
        updatedAt: new Date(0).toISOString(),
      });
    }
  };

  const fetchSceneInstantPlayback = async (targetProgramId: string) => {
    try {
      const res = await fetch(
        apiUrl(`/program/${encodeURIComponent(targetProgramId)}/scene-instant`),
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const payload = await res.json();
      if (targetProgramId !== activeProgramIdRef.current) {
        return;
      }
      if (!shouldApplyControlUpdatePayload(payload, "sceneInstant")) {
        return;
      }
      setSceneInstantPlayback(normalizeSceneInstantPlayback(payload));
    } catch (err) {
      if (targetProgramId !== activeProgramIdRef.current) {
        return;
      }
      console.error("Failed to fetch scene instant playback:", err);
      setSceneInstantPlayback({
        sceneId: null,
        instantId: null,
        mediaAssetId: null,
        instantName: "",
        isPlaying: false,
        updatedAt: new Date(0).toISOString(),
      });
    }
  };

  const fetchProgramState = async (targetProgramId: string) => {
    try {
      const res = await fetch(
        apiUrl(`/program/${encodeURIComponent(targetProgramId)}/state`),
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = (await res.json()) as unknown;
      if (targetProgramId !== activeProgramIdRef.current) {
        return;
      }
      if (!shouldApplyControlUpdatePayload(data, "state")) {
        return;
      }
      const normalizedProgramState = normalizeProgramState(data);

      syncProgramStateAndStagedScene(normalizedProgramState);
    } catch (err) {
      if (targetProgramId !== activeProgramIdRef.current) {
        return;
      }
      console.error("Failed to fetch program state:", err);
    }
  };

  const fetchProgramAudioBusSettings = async (
    targetProgramId: string,
    showLoading = true,
  ) => {
    try {
      if (showLoading) {
        setIsLoadingMixerLevels(true);
      }
      const res = await fetch(
        apiUrl(`/program/${encodeURIComponent(targetProgramId)}/audio-bus`),
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const payload =
        (await res.json()) as Partial<ProgramAudioBusSettings> | null;
      if (targetProgramId !== activeProgramIdRef.current) {
        return;
      }
      if (!shouldApplyControlUpdatePayload(payload, "audioBus")) {
        return;
      }
      const nextMixerLevels = normalizeBroadcastSettingsPayload(
        payload?.mixerSettings,
      );
      mixerLevelsRef.current = nextMixerLevels;
      setMixerLevels(nextMixerLevels);
      const normalizedSongSequence = normalizeProgramSongPlaylist(
        normalizeProgramSongSequence(payload?.songSequence) ?? {
          ...createProgramSongSequence("manual"),
          activeItemId: null,
        },
      );
      setProgramAudioBusSettings({
        songSequence: normalizedSongSequence,
        songQueue: normalizeProgramSongQueue(payload?.songQueue),
      });
    } catch (err) {
      if (targetProgramId !== activeProgramIdRef.current) {
        return;
      }
      console.error("Failed to fetch program audio bus settings:", err);
      const fallbackMixerLevels = normalizeBroadcastSettingsPayload(null);
      mixerLevelsRef.current = fallbackMixerLevels;
      setMixerLevels(fallbackMixerLevels);
      setProgramAudioBusSettings({
        songSequence: {
          ...createProgramSongSequence("manual"),
          activeItemId: null,
        },
        songQueue: [],
      });
    } finally {
      if (showLoading) {
        setIsLoadingMixerLevels(false);
      }
    }
  };

  const saveProgramAudioBusSongSequence = async (
    nextSequence: ProgramSongSequence,
  ) => {
    const normalizedSongSequence = normalizeProgramSongPlaylist(
      normalizeProgramSongSequence(nextSequence) ?? {
        ...createProgramSongSequence("manual"),
        activeItemId: null,
      },
    );
    setProgramAudioBusSettings((previous) => ({
      ...previous,
      songSequence: normalizedSongSequence,
    }));
    setIsSavingProgramAudioBus(true);

    try {
      const res = await fetch(
        apiUrl(`/program/${encodeURIComponent(activeProgramId)}/audio-bus`),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            songSequence: normalizedSongSequence,
          }),
        },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const payload =
        (await res.json()) as Partial<ProgramAudioBusSettings> | null;
      if (!shouldApplyControlUpdatePayload(payload, "audioBus")) {
        return;
      }
      if (
        payload &&
        Object.prototype.hasOwnProperty.call(payload, "mixerSettings")
      ) {
        const nextMixerLevels = normalizeBroadcastSettingsPayload(
          payload.mixerSettings,
        );
        mixerLevelsRef.current = nextMixerLevels;
        setMixerLevels(nextMixerLevels);
      }
      const persistedSongSequence = normalizeProgramSongPlaylist(
        normalizeProgramSongSequence(payload?.songSequence) ??
          normalizedSongSequence,
      );
      setProgramAudioBusSettings((previous) => ({
        ...previous,
        songSequence: persistedSongSequence,
        songQueue:
          payload?.songQueue === undefined
            ? previous.songQueue
            : normalizeProgramSongQueue(payload.songQueue),
      }));
    } catch (err) {
      console.error("Failed to save program audio bus settings:", err);
      await fetchProgramAudioBusSettings(activeProgramId, false);
      throw err;
    } finally {
      setIsSavingProgramAudioBus(false);
    }
  };

  const applySongQueueMutationResponse = (
    payload: unknown,
    targetProgramId: string,
  ) => {
    if (targetProgramId !== activeProgramIdRef.current) return;
    if (!payload || typeof payload !== "object") return;
    if (!shouldApplyControlUpdatePayload(payload, "audioBus")) return;
    const response = payload as { songQueue?: unknown };
    setProgramAudioBusSettings((previous) => ({
      ...previous,
      songQueue: normalizeProgramSongQueue(response.songQueue),
    }));
  };

  const enqueueProgramSong = async (itemId: string) => {
    const targetProgramId = activeProgramId;
    const res = await authFetch(
      `/program/${encodeURIComponent(targetProgramId)}/song-queue`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId }),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    applySongQueueMutationResponse(await res.json(), targetProgramId);
  };

  const removeQueuedProgramSong = async (entryId: string) => {
    const targetProgramId = activeProgramId;
    const res = await authFetch(
      `/program/${encodeURIComponent(targetProgramId)}/song-queue/${encodeURIComponent(entryId)}`,
      { method: "DELETE" },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    applySongQueueMutationResponse(await res.json(), targetProgramId);
  };

  const reorderProgramSongQueue = async (entryIds: string[]) => {
    const targetProgramId = activeProgramId;
    const res = await authFetch(
      `/program/${encodeURIComponent(targetProgramId)}/song-queue`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryIds }),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    applySongQueueMutationResponse(await res.json(), targetProgramId);
  };

  const takeProgramSongSelection = async (
    nextSequence: ProgramSongSequence,
  ) => {
    const wasPlaying = programSongPlaybackState.isPlaying;
    await saveProgramAudioBusSongSequence(nextSequence);
    const item = nextSequence.items.find(
      (candidate) => candidate.id === nextSequence.activeItemId,
    );
    if (!item || item.kind !== "preset" || !item.audioUrl) return;
    if (
      !wasPlaying &&
      (nextSequence.mode === "autoplay" || nextSequence.mode === "shuffle")
    ) {
      // Persisting an idle automatic sequence is itself the authoritative
      // start command. Posting the same song as a manual take would enqueue a
      // second Palazzo request.
      return;
    }
    const res = await fetch(
      apiUrl(`/radio/${encodeURIComponent(activeProgramId)}/song`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioUrl: item.audioUrl,
          title: item.title,
          artist: item.artist,
          coverUrl: item.coverUrl,
          durationMs: item.durationMs,
          songId: item.songId,
        }),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  };

  const takeProgramSongOffAir = async (
    targetProgramId: string = activeProgramId,
  ) => {
    console.log(`[Control] takeProgramSongOffAir programId=${targetProgramId}`);
    try {
      const res = await fetch(
        apiUrl(`/program/${encodeURIComponent(targetProgramId)}/song/off-air`),
        {
          method: "POST",
        },
      );

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      console.log(`[Control] takeProgramSongOffAir response ${res.status}`);
    } catch (err) {
      console.error("Failed to take song off air:", err);
      throw err;
    }
  };

  function buildComponentPropsForScene(scene: Scene): Record<string, any> {
    const metadata = parseSceneMetadata(scene.metadata);
    const legacyFifthBell =
      metadata?.fifthbell &&
      typeof metadata.fifthbell === "object" &&
      !Array.isArray(metadata.fifthbell)
        ? metadata.fifthbell
        : {};

    const components = scene.layout.componentType.split(",").filter(Boolean);
    const combined: Record<string, any> = {};

    for (const componentType of components) {
      const compatibleMetadata =
        componentType === "fifthbell-content" ||
        componentType === "fifthbell-marquee"
          ? { ...legacyFifthBell, ...(metadata[componentType] || {}) }
          : componentType === "toni-chyron" ||
              componentType === "fifthbell-chyron"
            ? {
                ...(metadata["toni-chyron"] || {}),
                ...(metadata["fifthbell-chyron"] || {}),
                ...(metadata[componentType] || {}),
              }
            : componentType === "toni-clock" ||
                componentType === "fifthbell-clock" ||
                componentType === "fifthbell-corner"
              ? {
                  ...legacyFifthBell,
                  ...(metadata["fifthbell-corner"] || {}),
                  ...(metadata["fifthbell-clock"] || {}),
                  ...(metadata["toni-clock"] || {}),
                  ...(metadata[componentType] || {}),
                }
              : metadata[componentType] || {};

      combined[componentType] = {
        ...getDefaultPropsForComponent(componentType),
        ...compatibleMetadata,
      };
    }

    const sceneInstantConfig =
      metadata?.sceneInstant &&
      typeof metadata.sceneInstant === "object" &&
      !Array.isArray(metadata.sceneInstant)
        ? (metadata.sceneInstant as Record<string, unknown>)
        : null;
    combined.sceneInstant = {
      instantId: normalizeSceneInstantId(sceneInstantConfig?.instantId) ?? null,
      assetId:
        typeof sceneInstantConfig?.assetId === 'string' && sceneInstantConfig.assetId.trim()
          ? sceneInstantConfig.assetId.trim()
          : null,
    };

    return combined;
  }

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

  const isSceneAssigned = (sceneId: number) =>
    assignedSceneEntries.some(
      (programScene) => programScene.sceneId === sceneId,
    );

  const assignSceneToProgram = async (sceneId: number) => {
    try {
      await fetch(
        apiUrl(`/program/${encodeURIComponent(activeProgramId)}/scenes`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sceneId }),
        },
      );
      if (!isProgramRealtimeConnected) {
        await fetchProgramState(activeProgramId);
      }
    } catch (err) {
      console.error("Failed to assign scene to program:", err);
    }
  };

  const stageSceneForProgram = async (sceneId: number | null) => {
    setTakeError(null);
    try {
      const response = await fetch(
        apiUrl(`/program/${encodeURIComponent(activeProgramId)}/stage`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sceneId }),
        },
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = (await response.json()) as StageSceneResponse;
      const acceptedResult = acceptStageSceneResponse<Scene>(
        result,
        shouldApplyControlUpdatePayload,
      );
      if (!acceptedResult) {
        return;
      }
      const { stagedSceneId, stagedScene } = acceptedResult;

      setSelectedScene(stagedSceneId);
      setProgramState((previous) =>
        previous
          ? {
              ...previous,
              stagedSceneId,
              stagedScene,
            }
          : previous,
      );

      if (!isProgramRealtimeConnected) {
        await fetchProgramState(activeProgramId);
      }
    } catch (err) {
      setTakeError(err instanceof Error ? `Could not prepare Preview: ${err.message}` : "Could not prepare Preview.");
      return false;
    }
  };

  const takeStagedSceneLive = async (transitionIdOverride?: string) => {
    const sceneId = selectedSceneRef.current;
    const programId = activeProgramIdRef.current;
    if (!sceneId || takeInFlightRef.current) return;
    takeInFlightRef.current = true;
    setTakeBusy(true);
    setTakeError(null);
    try {
      await flushSceneAttributeAutosaveForScene(sceneId);
      if (!isSceneAssigned(sceneId)) await assignSceneToProgram(sceneId);
      const result = await requestSceneTake(programId, sceneId, transitionIdOverride ?? selectedTransitionId);
      if (programId === activeProgramIdRef.current && shouldApplyControlUpdatePayload(result, "state")) {
        syncProgramStateAndStagedScene(normalizeProgramState(result));
      }
    } catch (error) {
      if (programId === activeProgramIdRef.current) {
        setTakeError(error instanceof Error ? error.message : "The scene was not taken to Program.");
      }
    } finally {
      takeInFlightRef.current = false;
      setTakeBusy(false);
    }
  };

  const setFadeToBlack = async (active: boolean) => {
    try {
      const response = await fetch(
        apiUrl(`/program/${encodeURIComponent(activeProgramId)}/fade-to-black`),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active }),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const nextState = normalizeProgramState(await response.json());
      if (nextState) syncProgramStateAndStagedScene(nextState);
    } catch (err) {
      console.error("Failed to change fade-to-black state:", err);
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
      setSceneAttributeSaveError("Scene save failed. Please try again.");
      console.error("Failed to save staged scene attributes:", err);
    } finally {
      setIsSavingSceneAttributes(false);
    }
  };

  const takeSceneInstant = async (
    sceneId: number | null = selectedScene,
    instantIdOverride?: number | null,
    mediaAssetIdOverride?: string | null,
  ) => {
    const normalizedSceneId =
      typeof sceneId === "number" && Number.isFinite(sceneId) ? sceneId : null;
    const normalizedInstantId = normalizeSceneInstantId(instantIdOverride);
    const normalizedMediaAssetId =
      typeof mediaAssetIdOverride === 'string' && mediaAssetIdOverride.trim()
        ? mediaAssetIdOverride.trim()
        : null;
    if (normalizedSceneId === null) {
      return;
    }

    try {
      await flushSceneAttributeAutosaveForScene(normalizedSceneId);
      const res = await fetch(
        apiUrl(
          `/program/${encodeURIComponent(activeProgramId)}/scene-instant/take`,
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sceneId: normalizedSceneId,
            instantId: normalizedInstantId,
            mediaAssetId: normalizedMediaAssetId,
          }),
        },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const payload = await res.json();
      setSceneInstantPlayback(normalizeSceneInstantPlayback(payload));
    } catch (err) {
      console.error("Failed to take scene instant:", err);
    }
  };

  const stopSceneInstant = async () => {
    try {
      const res = await fetch(
        apiUrl(
          `/program/${encodeURIComponent(activeProgramId)}/scene-instant/stop`,
        ),
        {
          method: "POST",
        },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const payload = await res.json();
      setSceneInstantPlayback(normalizeSceneInstantPlayback(payload));
    } catch (err) {
      console.error("Failed to stop scene instant:", err);
    }
  };

  const triggerInstant = async (instantId: number) => {
    try {
      const res = await fetch(
        apiUrl(
          `/instants/${instantId}/play?programId=${encodeURIComponent(activeProgramId)}`,
        ),
        {
          method: "POST",
        },
      );

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
          endsAtMs:
            typeof durationMs === "number" && durationMs > 0
              ? startedAtMs + durationMs
              : null,
        },
      }));

      if (typeof durationMs === "number" && durationMs > 0) {
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
      console.error("Failed to trigger instant:", err);
    }
  };

  const stopAllInstants = async () => {
    try {
      const res = await fetch(
        apiUrl(
          `/instants/stop-all?programId=${encodeURIComponent(activeProgramId)}`,
        ),
        {
          method: "POST",
        },
      );

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      Object.values(instantPlaybackTimeoutsRef.current).forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      instantPlaybackTimeoutsRef.current = {};
      setInstantPlayback({});
    } catch (err) {
      console.error("Failed to stop all instants:", err);
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
        setInstantDurationsMs((prev) =>
          prev[instant.id] === cachedDuration
            ? prev
            : { ...prev, [instant.id]: cachedDuration },
        );
        return;
      }

      const audio = new Audio();
      const cleanup = () => {
        audio.onloadedmetadata = null;
        audio.onerror = null;
        audio.src = "";
      };

      audio.preload = "metadata";
      audio.onloadedmetadata = () => {
        const seconds = Number(audio.duration);
        const durationMs =
          Number.isFinite(seconds) && seconds > 0
            ? Math.round(seconds * 1000)
            : null;
        instantDurationByUrlRef.current[instant.audioUrl] = durationMs;

        if (!cancelled) {
          setInstantDurationsMs((prev) => ({
            ...prev,
            [instant.id]: durationMs,
          }));
        }

        cleanup();
      };

      audio.onerror = () => {
        instantDurationByUrlRef.current[instant.audioUrl] = null;
        if (!cancelled) {
          setInstantDurationsMs((prev) => ({
            ...prev,
            [instant.id]: null,
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

  const updateSceneEditorProp = (
    componentType: string,
    propName: string,
    value: any,
  ) => {
    const nextSceneProps = {
      ...sceneEditorPropsRef.current,
      [componentType]: {
        ...sceneEditorPropsRef.current[componentType],
        [propName]: value,
      },
    };
    sceneEditorDirtyRef.current = true;
    sceneEditorPropsRef.current = nextSceneProps;
    setSceneEditorProps(nextSceneProps);
    if (selectedSceneRef.current) {
      queueSceneAttributePersist(selectedSceneRef.current, nextSceneProps);
    }
  };

  const replaceSceneEditorComponentProps = (
    componentType: string,
    nextProps: any,
  ) => {
    const nextSceneProps = {
      ...sceneEditorPropsRef.current,
      [componentType]: nextProps,
    };
    sceneEditorDirtyRef.current = true;
    sceneEditorPropsRef.current = nextSceneProps;
    setSceneEditorProps(nextSceneProps);
    if (selectedSceneRef.current) {
      queueSceneAttributePersist(selectedSceneRef.current, nextSceneProps);
    }
  };

  const syncSceneEditorComponentProps = (
    componentType: string,
    nextProps: any,
  ) => {
    const nextSceneProps = {
      ...sceneEditorPropsRef.current,
      [componentType]: nextProps,
    };
    sceneEditorDirtyRef.current = false;
    pendingSceneAttributeSaveRef.current = null;
    sceneEditorPropsRef.current = nextSceneProps;
    setSceneEditorProps(nextSceneProps);
    setSceneAttributeSaveError(null);
  };

  const persistSceneAttributes = useCallback(
    async (sceneId: number, nextSceneProps: ComponentPropsMap) => {
      const existingMetadata = sceneMetadataCacheRef.current[sceneId] ?? {};
      const nextMetadata = withIndependentProgramClockMetadata({
        ...existingMetadata,
        ...nextSceneProps,
      });

      const response = await fetch(apiUrl(`/scenes/${sceneId}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metadata: nextMetadata,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const persistedScene = (await response.json()) as Scene;
      applySceneUpdateLocally(persistedScene);
    },
    [applySceneUpdateLocally],
  );

  const flushQueuedSceneAttributeSaves = useCallback((): Promise<void> => {
    if (sceneAttributeSaveDrainPromiseRef.current) {
      return sceneAttributeSaveDrainPromiseRef.current;
    }

    if (!pendingSceneAttributeSaveRef.current) {
      return Promise.resolve();
    }

    return runSceneSaveDrain(sceneAttributeSaveDrainPromiseRef, async () => {
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
            pendingSceneAttributeSaveRef.current ??= payload;
            setSceneAttributeSaveError("Scene save failed. Retrying...");
            console.error("Failed to update scene attributes:", err);
            lastError = err;
            break;
          }
        }
      } finally {
        setIsSavingSceneAttributes(false);
      }

      if (lastError) {
        if (
          pendingSceneAttributeSaveRef.current &&
          sceneAttributeRetryTimerRef.current === null
        ) {
          const retryDelayMs = sceneAttributeRetryDelayMsRef.current;
          sceneAttributeRetryTimerRef.current = window.setTimeout(() => {
            sceneAttributeRetryTimerRef.current = null;
            void flushQueuedSceneAttributeSaves().catch(() => {
              // no-op, retry timer is rescheduled in flush on failure
            });
          }, retryDelayMs);
          sceneAttributeRetryDelayMsRef.current = Math.min(
            8000,
            Math.round(retryDelayMs * 1.8),
          );
        }
        throw lastError;
      }

      setSceneAttributeSaveError(null);
    }, () => {

      // If a new payload was queued while the previous drain promise was
      // still resolving, guarantee we kick off another drain pass.
      if (
        pendingSceneAttributeSaveRef.current &&
        !sceneAttributeSaveDrainPromiseRef.current &&
        sceneAttributeRetryTimerRef.current === null
      ) {
        void flushQueuedSceneAttributeSaves().catch(() => {
          // no-op, retry timer is scheduled by flush
        });
      }
    });

  }, [persistSceneAttributes]);

  const queueSceneAttributePersist = useCallback(
    (sceneId: number, nextSceneProps: ComponentPropsMap) => {
      const signature = JSON.stringify(nextSceneProps);
      const payload: SceneAttributeSavePayload = {
        sceneId,
        signature,
        props: JSON.parse(signature) as ComponentPropsMap,
        revision: ++sceneEditorRevisionRef.current,
      };
      pendingSceneAttributeSaveRef.current = payload;
      void flushQueuedSceneAttributeSaves().catch(() => {
        // no-op, retry timer is scheduled by flush
      });

      if (sceneAttributeFlushKickTimerRef.current === null) {
        sceneAttributeFlushKickTimerRef.current = window.setTimeout(() => {
          sceneAttributeFlushKickTimerRef.current = null;
          if (
            pendingSceneAttributeSaveRef.current &&
            !sceneAttributeSaveDrainPromiseRef.current &&
            sceneAttributeRetryTimerRef.current === null
          ) {
            void flushQueuedSceneAttributeSaves().catch(() => {
              // no-op, retry timer is scheduled by flush
            });
          }
        }, 0);
      }
    },
    [flushQueuedSceneAttributeSaves],
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
    [flushQueuedSceneAttributeSaves, queueSceneAttributePersist],
  );

  const commitSceneEditorComponentProps = async (
    componentType: string,
    nextProps: any,
  ) => {
    const nextSceneProps = {
      ...sceneEditorPropsRef.current,
      [componentType]: nextProps,
    };
    sceneEditorDirtyRef.current = true;
    sceneEditorPropsRef.current = nextSceneProps;
    setSceneEditorProps(nextSceneProps);
    if (selectedSceneRef.current) {
      queueSceneAttributePersist(selectedSceneRef.current, nextSceneProps);
      try {
        await flushQueuedSceneAttributeSaves();
      } catch (err) {
        console.error("Failed to commit scene editor component props:", err);
      }
    }
  };

  useEffect(() => {
    const previousSelectedSceneId = previousSelectedSceneRef.current;
    if (
      previousSelectedSceneId !== null &&
      previousSelectedSceneId !== selectedScene
    ) {
      const previousProps = sceneEditorPropsRef.current;
      if (sceneEditorDirtyRef.current) {
        queueSceneAttributePersist(previousSelectedSceneId, previousProps);
      }
    }
    previousSelectedSceneRef.current = selectedScene;

    if (
      previousSelectedSceneId !== null &&
      previousSelectedSceneId === selectedScene &&
      (sceneEditorDirtyRef.current ||
        pendingSceneAttributeSaveRef.current ||
        sceneAttributeSaveDrainPromiseRef.current)
    ) {
      return;
    }

    if (!selectedScene) {
      sceneEditorAutosaveSignatureRef.current = "";
      sceneEditorDirtyRef.current = false;
      sceneEditorRevisionRef.current = 0;
      setSceneAttributeSaveError(null);
      sceneEditorPropsRef.current = {};
      setSceneEditorProps({});
      return;
    }

    const scene =
      assignedScenes.find((entry) => entry.id === selectedScene) ??
      scenes.find((entry) => entry.id === selectedScene);
    if (!scene) {
      sceneEditorAutosaveSignatureRef.current = "";
      sceneEditorDirtyRef.current = false;
      sceneEditorRevisionRef.current = 0;
      setSceneAttributeSaveError(null);
      sceneEditorPropsRef.current = {};
      setSceneEditorProps({});
      return;
    }

    sceneMetadataCacheRef.current[selectedScene] = parseSceneMetadata(
      scene.metadata,
    );
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
      queueSceneAttributePersist(
        selectedSceneRef.current,
        sceneEditorPropsRef.current,
      );
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

    window.addEventListener("pagehide", flushPendingSceneSaves);
    window.addEventListener("beforeunload", flushPendingSceneSaves);
    return () => {
      window.removeEventListener("pagehide", flushPendingSceneSaves);
      window.removeEventListener("beforeunload", flushPendingSceneSaves);
    };
  }, [flushQueuedSceneAttributeSaves, flushSceneAttributeAutosaveForScene]);

  const openSceneModal = () => {
    if (layouts.length === 0) {
      alert("Please create a layout first");
      return;
    }
    setEditingScene(null);
    setNewSceneName("");
    setSelectedLayoutId(null);
    setSceneComponentProps({});
    setSceneErrors({ name: "", layout: "", props: "" });
    setShowSceneModal(true);
  };

  const openEditSceneModal = (scene: Scene) => {
    setEditingScene(scene);
    setNewSceneName(scene.name);
    setSelectedLayoutId(scene.layoutId);

    try {
      const metadata = parseSceneMetadata(scene.metadata);
      if (
        metadata &&
        typeof metadata === "object" &&
        !Array.isArray(metadata)
      ) {
        setSceneComponentProps(buildComponentPropsForScene(scene));
      } else {
        handleLayoutSelect(scene.layoutId);
      }
    } catch (err) {
      console.error("Failed to parse scene metadata:", err);
      handleLayoutSelect(scene.layoutId);
    }

    setSceneErrors({ name: "", layout: "", props: "" });
    setShowSceneModal(true);
  };

  const closeSceneModal = () => {
    setShowSceneModal(false);
    setEditingScene(null);
    setNewSceneName("");
    setSelectedLayoutId(null);
    setSceneComponentProps({});
    setSceneErrors({ name: "", layout: "", props: "" });
  };

  const handleLayoutSelect = (layoutId: number) => {
    setSelectedLayoutId(layoutId);
    const layout = layouts.find((l) => l.id === layoutId);
    if (layout) {
      const components = layout.componentType.split(",").filter(Boolean);
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
      case "header":
        return {
          ...base,
          date: new Date().toLocaleDateString("es-ES", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
          }),
        };
      case "reloj-digital-loop-clock":
        return {
          ...base,
          textSequence: createProgramTextSequence("manual"),
          ctaSequence: createProgramTextSequence("manual"),
        };
      case "modoitaliano-chyron":
      case "modoitaliano-giorgia-chyron":
        return {
          ...base,
          textSequence: createProgramTextSequence("manual", {
            includeMarquee: true,
          }),
          ctaSequence: createProgramTextSequence("manual"),
        };
      case "fifthbell-content":
        return {
          ...base,
          weatherCities: [...FIFTHBELL_AVAILABLE_WEATHER_CITIES],
        };
      case "fifthbell":
        return {
          ...getDefaultPropsForComponent("fifthbell-content"),
          ...getDefaultPropsForComponent("fifthbell-marquee"),
          ...getDefaultPropsForComponent("toni-clock"),
        };
      default:
        return base;
    }
  };

  const updateComponentProp = (
    componentType: string,
    propName: string,
    value: any,
  ) => {
    setSceneComponentProps((prev) => ({
      ...prev,
      [componentType]: {
        ...prev[componentType],
        [propName]: value,
      },
    }));
  };

  const replaceSceneComponentProps = (
    componentType: string,
    nextProps: any,
  ) => {
    setSceneComponentProps((prev) => ({
      ...prev,
      [componentType]: nextProps,
    }));
  };

  const createScene = async () => {
    const errors = { name: "", layout: "", props: "" };

    if (!newSceneName.trim()) {
      errors.name = "Please enter a scene name";
    }

    if (!selectedLayoutId) {
      errors.layout = "Please select a layout";
    }

    if (errors.name || errors.layout) {
      setSceneErrors(errors);
      return;
    }

    setIsCreatingScene(true);

    try {
      const existingMetadata = editingScene
        ? parseSceneMetadata(editingScene.metadata)
        : {};
      const payload = {
        name: newSceneName,
        layoutId: selectedLayoutId,
        metadata: withIndependentProgramClockMetadata({
          ...existingMetadata,
          ...sceneComponentProps,
        }),
      };

      const url = editingScene
        ? apiUrl(`/scenes/${editingScene.id}`)
        : apiUrl("/scenes");
      const method = editingScene ? "PUT" : "POST";

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      await fetchScenes();
      closeSceneModal();
    } catch (err) {
      console.error("Failed to save scene:", err);
      setSceneErrors({
        ...errors,
        name: "Failed to save scene. Please try again.",
      });
    } finally {
      setIsCreatingScene(false);
    }
  };

  const deleteScene = async (id: number) => {
    if (!confirm("Are you sure you want to delete this scene?")) return;

    try {
      await fetch(apiUrl(`/scenes/${id}`), {
        method: "DELETE",
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
      console.error("Failed to delete scene:", err);
    }
  };

  useEffect(() => {
    let sceneHotkeyArmedUntil = 0;

    const handleSceneHotkey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      if (event.ctrlKey && key === "s") {
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

    window.addEventListener("keydown", handleSceneHotkey);
    return () => {
      window.removeEventListener("keydown", handleSceneHotkey);
    };
  }, [
    assignedScenes,
    instants,
    takeStagedSceneLive,
    triggerInstant,
    stageSceneForProgram,
  ]);

  const [radioPlayoutError, setRadioPlayoutError] = useState<string | null>(null);
  useEffect(() => setRadioPlayoutError(null), [activeProgramId]);

  const handleProgramEvent = useCallback(
    (data: any) => {
      if (!data || typeof data !== "object") {
        return;
      }

      const eventProgramId =
        typeof data.programId === "string" ? data.programId : "";
      if (eventProgramId && eventProgramId !== activeProgramIdRef.current) {
        return;
      }

      if (data.type === "radio_rotation_resume_failed") {
        setRadioPlayoutError(
          "The timed block ended, but continuous fillers could not resume. Check the engine before starting the rotation.",
        );
        return;
      }
      if (
        data.type === "radio_log_start_failed" ||
        data.type === "radio_log_cue_failed"
      ) {
        setRadioPlayoutError(
          "The timed block could not play. Check its audio and the engine before restarting.",
        );
        return;
      }
      if (data.type === "song_playback_update" && data.playback?.isPlaying)
        setRadioPlayoutError(null);

      if (!shouldApplyControlUpdatePayload(data)) {
        return;
      }

      if (
        data.type === "program_state_snapshot" ||
        data.type === "scene_change" ||
        data.type === "program_scenes_changed" ||
        data.type === "program_media_groups_changed"
      ) {
        const normalizedProgramState = normalizeProgramState(data.state);
        syncProgramStateAndStagedScene(normalizedProgramState);
        if (data.type === "program_media_groups_changed") {
          void fetchMediaGroups(activeProgramId);
        }
        return;
      }

      if (data.type === "fade_to_black") {
        syncProgramStateAndStagedScene(normalizeProgramState(data.state));
        return;
      }

      if (data.type === "scene_staged") {
        const nextStagedSceneId =
          typeof data.stagedSceneId === "number" ? data.stagedSceneId : null;
        setSelectedScene(nextStagedSceneId);
        setProgramState((previous) => {
          if (!previous) {
            return previous;
          }
          return {
            ...previous,
            stagedSceneId: nextStagedSceneId,
            stagedScene:
              data.scene && typeof data.scene === "object"
                ? (data.scene as Scene)
                : null,
          };
        });
        return;
      }

      if (data.type === "scene_update") {
        if (data.scene && typeof data.scene === "object") {
          applySceneUpdateLocally(data.scene as Scene);
        }
        return;
      }

      if (data.type === "scene_cleared") {
        setProgramState((prev) => {
          if (!prev) {
            return prev;
          }
          return {
            ...prev,
            activeSceneId: null,
          };
        });
        return;
      }

      if (data.type === "audio_bus_update") {
        const nextMixerSource =
          data.settings && typeof data.settings === "object"
            ? (data.settings as { mixerSettings?: unknown }).mixerSettings
            : undefined;
        if (nextMixerSource !== undefined) {
          const nextMixerLevels =
            normalizeBroadcastSettingsPayload(nextMixerSource);
          mixerLevelsRef.current = nextMixerLevels;
          setMixerLevels(nextMixerLevels);
        }
        const normalizedSongSequence = normalizeProgramSongPlaylist(
          normalizeProgramSongSequence(data?.settings?.songSequence) ?? {
            ...createProgramSongSequence("manual"),
            activeItemId: null,
          },
        );
        setProgramAudioBusSettings((previous) => ({
          ...previous,
          songSequence: normalizedSongSequence,
          songQueue:
            data?.settings?.songQueue === undefined
              ? previous.songQueue
              : normalizeProgramSongQueue(data.settings.songQueue),
        }));
        return;
      }

      if (data.type === "song_queue_update") {
        setProgramAudioBusSettings((previous) => ({
          ...previous,
          songQueue: normalizeProgramSongQueue(data.songQueue),
          songSequence:
            data.songSequence === undefined
              ? previous.songSequence
              : normalizeProgramSongPlaylist(
                  normalizeProgramSongSequence(data.songSequence) ?? {
                    ...createProgramSongSequence("manual"),
                    activeItemId: null,
                  },
                ),
        }));
        return;
      }

      if (data.type === "audio_meter_update") {
        setProgramAudioMeterLevels((previous) =>
          reconcileProgramAudioMeter(
            previous,
            normalizeProgramAudioMeter(data.levels),
          ),
        );
        return;
      }

      if (data.type === "song_playback_update") {
        setProgramSongPlaybackState((previous) =>
          reconcileProgramSongPlayback(
            previous,
            normalizeProgramSongPlayback(data.playback),
          ),
        );
        return;
      }

      if (data.type === "song_off_air") {
        setProgramSongPlaybackState((previous) =>
          reconcileProgramSongOffAir(previous, data.playback, data.triggeredAt),
        );
        return;
      }

      if (data.type === "scene_instant_state") {
        setSceneInstantPlayback(normalizeSceneInstantPlayback(data.playback));
        return;
      }

      if (data.type === "scene_instant_take") {
        setSceneInstantPlayback({
          sceneId: normalizeSceneInstantId(data.sceneId),
          instantId: normalizeSceneInstantId(data.instant?.id),
          mediaAssetId:
            typeof data.instant?.assetId === "string" && data.instant.assetId.trim()
              ? data.instant.assetId.trim()
              : null,
          instantName:
            typeof data.instant?.name === "string" ? data.instant.name : "",
          isPlaying: true,
          updatedAt:
            typeof data.triggeredAt === "string"
              ? data.triggeredAt
              : new Date().toISOString(),
        });
        return;
      }

      if (data.type === "scene_instant_stop") {
        setSceneInstantPlayback((previous) => ({
          ...previous,
          isPlaying: false,
          updatedAt:
            typeof data.triggeredAt === "string"
              ? data.triggeredAt
              : new Date().toISOString(),
        }));
      }
    },
    [
      activeProgramId,
      applySceneUpdateLocally,
      shouldApplyControlUpdatePayload,
      syncProgramStateAndStagedScene,
    ],
  );

  useSSE({
    url: apiUrl(`/program/${encodeURIComponent(activeProgramId)}/events`),
    onMessage: handleProgramEvent,
    onConnectionStateChange: setProgramSseConnectionState,
  });

  const editableSceneComponentEntries = Object.entries(sceneEditorProps).filter(
    ([componentType]) =>
      componentType !== "chyron" &&
      hasConfigurableSceneAttributes(componentType),
  );
  const stagedSceneData = selectedScene
    ? (assignedScenes.find((scene) => scene.id === selectedScene) ?? null)
    : null;
  const activeSceneId = programState?.activeSceneId ?? null;
  const selectedSceneInstantId = normalizeSceneInstantId(
    sceneEditorProps?.sceneInstant?.instantId,
  );
  const selectedLegacyInstant = selectedSceneInstantId
    ? (instants.find((instant) => instant.id === selectedSceneInstantId) ?? null)
    : null;
  const selectedBackgroundAudioAssetId =
    typeof sceneEditorProps?.sceneInstant?.assetId === 'string' && sceneEditorProps.sceneInstant.assetId.trim()
      ? sceneEditorProps.sceneInstant.assetId.trim()
      : (selectedLegacyInstant?.assetId ?? null);
  const selectedBackgroundAudioAsset = selectedBackgroundAudioAssetId
    ? (backgroundAudioAssets.find((asset) => asset.id === selectedBackgroundAudioAssetId) ?? null)
    : null;
  const stagedIsOnAir =
    selectedScene !== null && selectedScene === activeSceneId;
  const programAudioBusSongSequence = useMemo(
    () =>
      normalizeProgramSongPlaylist(
        normalizeProgramSongSequence(programAudioBusSettings.songSequence) ?? {
          ...createProgramSongSequence("manual"),
          activeItemId: null,
        },
      ),
    [programAudioBusSettings.songSequence],
  );
  const activeSceneComponentTypes = (
    programState?.activeScene?.layout.componentType || ""
  )
    .split(",")
    .filter(Boolean);
  const stagedSceneComponentTypes = (
    stagedSceneData?.layout.componentType || ""
  )
    .split(",")
    .filter(Boolean);
  const shouldShowStreamStrip =
    activeSceneComponentTypes.includes("video-stream") ||
    stagedSceneComponentTypes.includes("video-stream");
  const songMeterFill = meterLevelToFill(programAudioMeterLevels.song.vu);
  const songPeakFill = meterLevelToFill(programAudioMeterLevels.song.peak);
  const songPeakHoldFill = meterLevelToFill(
    programAudioMeterLevels.song.peakHold,
  );
  const instantsMeterFill = meterLevelToFill(
    programAudioMeterLevels.instants.vu,
  );
  const instantsPeakFill = meterLevelToFill(
    programAudioMeterLevels.instants.peak,
  );
  const instantsPeakHoldFill = meterLevelToFill(
    programAudioMeterLevels.instants.peakHold,
  );
  const sceneInstantMeterFill = meterLevelToFill(
    programAudioMeterLevels.sceneInstant.vu,
  );
  const sceneInstantPeakFill = meterLevelToFill(
    programAudioMeterLevels.sceneInstant.peak,
  );
  const sceneInstantPeakHoldFill = meterLevelToFill(
    programAudioMeterLevels.sceneInstant.peakHold,
  );
  const mainMixMeterFill = meterLevelToFill(programAudioMeterLevels.main.vu);
  const mainMixPeakFill = meterLevelToFill(programAudioMeterLevels.main.peak);
  const mainMixPeakHoldFill = meterLevelToFill(
    programAudioMeterLevels.main.peakHold,
  );
  const tvAudioInputs: TvAudioChannel[] = [
    {
      id: "song",
      label: "Music",
      volume: mixerLevels.songMasterVolume,
      muted: mixerLevels.songMuted,
      solo: mixerLevels.songSolo,
      onVolumeChange: setSongMasterVolume,
      onToggleMuted: toggleSongMuted,
      onToggleSolo: toggleSongSolo,
      meter: { fill: songMeterFill, peak: songPeakFill, hold: songPeakHoldFill },
    },
    ...(shouldShowStreamStrip
      ? [
          {
            id: "stream" as const,
            label: "Stream",
            volume: mixerLevels.streamMasterVolume,
            muted: mixerLevels.streamMuted,
            solo: mixerLevels.streamSolo,
            onVolumeChange: setStreamMasterVolume,
            onToggleMuted: toggleStreamMuted,
            onToggleSolo: toggleStreamSolo,
          },
        ]
      : []),
    {
      id: "instants",
      label: "Cartwall",
      volume: mixerLevels.instantMasterVolume,
      muted: mixerLevels.instantMuted,
      solo: mixerLevels.instantSolo,
      onVolumeChange: setInstantMasterVolume,
      onToggleMuted: toggleInstantMuted,
      onToggleSolo: toggleInstantSolo,
      meter: {
        fill: instantsMeterFill,
        peak: instantsPeakFill,
        hold: instantsPeakHoldFill,
      },
    },
    {
      id: "sceneInstant",
      label: "Scene audio",
      volume: mixerLevels.sceneInstantMasterVolume,
      muted: mixerLevels.sceneInstantMuted,
      solo: mixerLevels.sceneInstantSolo,
      onVolumeChange: setSceneInstantMasterVolume,
      onToggleMuted: toggleSceneInstantMuted,
      onToggleSolo: toggleSceneInstantSolo,
      meter: {
        fill: sceneInstantMeterFill,
        peak: sceneInstantPeakFill,
        hold: sceneInstantPeakHoldFill,
      },
    },
    {
      id: "main",
      label: "Main mix",
      volume: mixerLevels.mainMasterVolume,
      onVolumeChange: setMainMasterVolume,
      meter: {
        fill: mainMixMeterFill,
        peak: mainMixPeakFill,
        hold: mainMixPeakHoldFill,
      },
    },
  ];
  const tvAudioChannels = tvAudioInputs.map((channel) =>
    channel.id === "main"
      ? channel
      : {
          ...channel,
          presets: mixerTakePresetsDb[channel.id],
          taking: isApplyingTakePresetByChannel[channel.id],
          onCommitPreset: (side: MixerTakePresetSide, raw: string) =>
            commitTakePresetDbInput(
              channel.id,
              side,
              raw,
              mixerTakePresetsDb[channel.id][side === "a" ? "aDb" : "bDb"],
            ),
          onTake: (side: MixerTakePresetSide) =>
            triggerChannelTake(channel.id, side),
        },
  );
  if (!programState) {
    return (
      <div className="flex h-full min-h-64 items-center justify-center bg-dark-sand text-text-secondary">
        <div className="flex items-center gap-3" role="status">
          <LoadingSpinner size="sm" />
          Loading {activeProgramId} control surface…
        </div>
      </div>
    );
  }

  if (programState.type === "radio") {
    return (
      <RadioPanel
        programId={activeProgramId}
        playoutError={radioPlayoutError}
        songSequence={programAudioBusSongSequence}
        songQueue={normalizeProgramSongQueue(programAudioBusSettings.songQueue)}
        songCatalog={songCatalog}
        programSongPlayback={programSongPlaybackState}
        onSaveSongSequence={async (seq) => {
          await saveProgramAudioBusSongSequence(seq);
        }}
        onTakeSelection={takeProgramSongSelection}
        onQueueSong={enqueueProgramSong}
        onRemoveQueuedSong={removeQueuedProgramSong}
        onReorderSongQueue={reorderProgramSongQueue}
        onTakeOffAir={async () => {
          await takeProgramSongOffAir(activeProgramId);
        }}
        instants={instants}
        instantSearch={instantSearch}
        onInstantSearchChange={setInstantSearch}
        onTriggerInstant={(id) => triggerInstant(id)}
        onStopAllInstants={stopAllInstants}
        instantPlayback={instantPlayback}
        mixer={{
          song: {
            volume: mixerLevels.songMasterVolume,
            muted: mixerLevels.songMuted,
            peak: programAudioMeterLevels.song.peak,
          },
          instants: {
            volume: mixerLevels.instantMasterVolume,
            muted: mixerLevels.instantMuted,
            peak: programAudioMeterLevels.instants.peak,
          },
          main: {
            volume: mixerLevels.mainMasterVolume,
            peak: programAudioMeterLevels.main.peak,
          },
          saving: isSavingMixerLevels,
          error: mixerSaveError,
        }}
        onSongVolumeChange={setSongMasterVolume}
        onInstantVolumeChange={setInstantMasterVolume}
        onMainVolumeChange={setMainMasterVolume}
        onToggleSongMuted={toggleSongMuted}
        onToggleInstantMuted={toggleInstantMuted}
      />
    );
  }

  return (
    <div className="broadcast-console flex h-full w-full flex-1 min-h-0 flex-col overflow-y-auto bg-dark-sand text-text-primary">
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
      {programState?.type === "both" ? (
        <SimulcastStatusRail programId={activeProgramId} />
      ) : null}
      <BroadcastSwitcherDeck
        programId={activeProgramId}
        activeScene={programState?.activeScene ?? null}
        stagedScene={stagedSceneData}
        scenes={assignedScenes}
        transitionId={selectedTransitionId}
        realtimeConnected={isProgramRealtimeConnected}
        fadeToBlack={programState?.fadeToBlack === true}
        workspace={consoleWorkspace}
        onWorkspaceChange={(workspace) =>
          consolePreferences.updateProfile({ workspace })
        }
        onTransitionChange={setSelectedTransitionId}
        onStageScene={stageSceneForProgram}
        takeBusy={takeBusy}
        takeError={takeError}
        onTake={() => takeStagedSceneLive()}
        onCut={() => takeStagedSceneLive("cut")}
        onFadeToBlack={() =>
          void setFadeToBlack(programState?.fadeToBlack !== true)
        }
      />
      {consoleWorkspace === "audio" ? (
        <TvAudioWorkspace
          programId={activeProgramId}
          activeScene={programState?.activeScene ?? null}
          mixer={{
            channels: tvAudioChannels,
            fadeMs: takePresetFadeMs,
            onFadeChange: (value) =>
              setTakePresetFadeMs(
                normalizeTakeVolumeFadeMs(value, takePresetFadeMs),
              ),
            loading: isLoadingMixerLevels,
            saving: isSavingMixerLevels,
            error: mixerSaveError,
          }}
          music={{
            sequence: programAudioBusSongSequence,
            songCatalog,
            programSongPlayback: programSongPlaybackState,
            onChange: (next) => {
              void saveProgramAudioBusSongSequence(next);
            },
            onTakeSelection: takeProgramSongSelection,
            onAddSongs: () => setIsPlaylistSheetOpen(true),
          }}
          cartwall={{
            isLoading: isLoadingInstants,
            instants,
            search: instantSearch,
            playback: instantPlayback,
            onSearchChange: setInstantSearch,
            onTrigger: (id) => {
              void triggerInstant(id);
            },
            onStopAll: () => {
              void stopAllInstants();
            },
          }}
          recording={
            <details
              className="console-recording"
              onToggle={(event) => setRecordingOpen(event.currentTarget.open)}
            >
              <summary>Program recording</summary>
              {recordingOpen && <RecordingPanel programId={activeProgramId} />}
            </details>
          }
        />
      ) : (
        <>
          <details
            className="console-recording"
            onToggle={(event) => setRecordingOpen(event.currentTarget.open)}
          >
            <summary className="cursor-pointer px-4 py-2 text-sm font-medium text-text-secondary">
              Program recording
            </summary>
            {recordingOpen && <RecordingPanel programId={activeProgramId} />}
          </details>
          <div
            className={`console-scene-workspace w-full ${consoleWorkspace === "compact" ? "hidden" : ""}`}
            data-workspace-content={consoleWorkspace}
          >
            <SceneAttributesPanel
              selectedScene={selectedScene}
              scenes={scenes}
              stagedIsOnAir={stagedIsOnAir}
              isSavingSceneAttributes={isSavingSceneAttributes}
              sceneAttributeSaveError={sceneAttributeSaveError}
              editableSceneComponentEntries={
                editableSceneComponentEntries
              }
              componentTypes={componentTypes}
              sceneEditorProps={sceneEditorProps}
              selectedSceneInstantId={selectedSceneInstantId}
              selectedBackgroundAudioAssetId={
                selectedBackgroundAudioAssetId
              }
              selectedBackgroundAudioAsset={selectedBackgroundAudioAsset}
              sceneInstantPlayback={sceneInstantPlayback}
              activeProgramId={activeProgramId}
              backgroundAudioAssets={backgroundAudioAssets}
              isLoadingBackgroundAudio={isLoadingBackgroundAudio}
              songCatalog={songCatalog}
              mediaGroups={mediaGroups}
              isLoadingMediaGroups={isLoadingMediaGroups}
              mediaLabels={mediaLabels}
              isLoadingMediaLabels={isLoadingMediaLabels}
              onBlurCapture={(event) => {
                if (selectedSceneRef.current !== null) {
                  void flushSceneAttributeAutosaveForScene(
                    selectedSceneRef.current,
                  ).catch(() => {});
                }
              }}
              onSave={() => void saveStagedSceneAttributes()}
              onCommitComponentProps={(componentType, props) =>
                commitSceneEditorComponentProps(componentType, props)
              }
              onUpdateProp={updateSceneEditorProp}
              onReplaceProps={replaceSceneEditorComponentProps}
              onSyncComponentProps={syncSceneEditorComponentProps}
              onTakeSceneInstant={(sceneId, instantId, mediaAssetId) =>
                takeSceneInstant(sceneId, instantId, mediaAssetId)
              }
              onStopSceneInstant={() => stopSceneInstant()}
            />
          </div>
        </>
      )}
      {consoleWorkspace === "audio" && (
        <div className="tv-audio-transport relative z-20 shrink-0">
          <PlaybackBar
            sequence={programAudioBusSongSequence}
            programSongPlayback={programSongPlaybackState}
            sceneQuickActions={[]}
            onChange={(nextSequence) => {
              void saveProgramAudioBusSongSequence(nextSequence);
            }}
            onTakeSelection={async (nextSequence) => {
              await takeProgramSongSelection(nextSequence);
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
          />
        </div>
      )}
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
          await takeProgramSongSelection(nextSequence);
        }}
      />
    </div>
  );
}
