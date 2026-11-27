import { RotationLoadNotice, ROTATION_NOT_LOADED } from "../components/RotationLoadNotice";
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
import { cartModifierHeld, platformIsMac } from "../utils/cartModifier";
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
  rowsAsPlayOrder,
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
import { TapePanel } from "../components/TapePanel";
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
import { playoutCutNotice, songRequestFailureNotice } from "../utils/songRequestFailure";
import { failureMessage, responseFailure } from "../utils/responseFailure";
import { createRotationVersion } from "../utils/rotationVersion";
import {
  DEFAULT_MIXER_TAKE_APPLYING,
  DEFAULT_MIXER_TAKE_PRESETS_DB,
  DEFAULT_MIXER_TAKE_RUN_IDS,
  DEFAULT_MIXER_TAKE_TIMERS,
  FIFTHBELL_AVAILABLE_WEATHER_CITIES,
  INSTANT_PLAYBACK_PULSE_ANIMATION,
  INSTANT_PLAYBACK_SWEEP_ANIMATION,
  MIXER_TAKE_CHANNELS,
  SONG_PROGRESS_FILL_ANIMATION,
  TAKE_VOLUME_PRESET_FADE_STEP_MIN_MS,
  createEmptyMeterChannel,
  defaultMixerChannelsFromScalars,
  getInstantShortcutIndex,
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
  // Why the song library or the cartwall did not load, shown with a retry
  // instead of an empty list (gaulatti/alcantara#253).
  const [songCatalogLoadError, setSongCatalogLoadError] = useState<
    string | null
  >(null);
  const [instantsLoadError, setInstantsLoadError] = useState<string | null>(
    null,
  );
  // The last refused instant or Stop all, cleared when the next one starts.
  const [instantError, setInstantError] = useState<string | null>(null);
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
  // A scene catalog that failed to load is shown, not hidden behind an empty
  // list.
  const [sceneCatalogError, setSceneCatalogError] = useState<string | null>(null);
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
  // The scene whose edits a queued or manual save has already sent, so a manual save does not send them again.
  const sceneDrainedIdRef = useRef<number | null>(null);
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
  const [selectedTransitionId, setSelectedTransitionId] =
    useGlobalTransitionId(activeProgramId);
  const consoleWorkspace = consolePreferences.profile.workspace;
  // The rotation did not load: its surfaces show the notice and every save is refused until a load succeeds.
  const [rotationLoadFailed, setRotationLoadFailed] = useState(false);
  const rotationLoadFailedRef = useRef(false);
  const [programAudioBusSettings, setProgramAudioBusSettings] =
    useState<ProgramAudioBusSettings>({
      songSequence: createProgramSongSequence("manual"),
      songQueue: [],
    });
  const [isSavingProgramAudioBus, setIsSavingProgramAudioBus] = useState(false);
  const [rotationVersion] = useState(createRotationVersion);
  const [songSequenceSaveError, setSongSequenceSaveError] = useState<
    string | null
  >(null);
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
  // Whether the event stream has connected for the current show: a later connect is a reconnect.
  const sseConnectedBeforeRef = useRef(false);
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

  // A reconnect may reach a restarted backend, whose topic versions start again from 0: every update and snapshot it
  // sent was dropped as older than the last one seen, and the radio desk sat on a false state ("Couldn't load the
  // rotation", Manual, nothing cued) until a reload (walk part 5). Start again from the process reached.
  const resyncWithReachedBackend = (programId: string) => {
    latestControlVersionByTopicRef.current = {
      state: -1,
      audioBus: -1,
      audioMeter: -1,
      songPlayback: -1,
      sceneInstant: -1,
      flight: -1,
    };
    void fetchProgramState(programId);
    void fetchProgramAudioBusSettings(programId, false);
    void fetchProgramAudioMeter(programId);
    void fetchProgramSongPlayback(programId);
    void fetchSceneInstantPlayback(programId);
  };

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
    fetchComponentTypes();
    fetchSongCatalog();
  }, []);

  // The route's static title is the TV console's; a radio show's tab names the radio desk.
  const documentTitle = programState?.type === "radio" ? "Control Panel - Radio" : "Control Panel - TV Broadcast";
  useEffect(() => {
    document.title = documentTitle;
  }, [documentTitle]);

  useEffect(() => {
    setProgramState(null);
    setSelectedScene(null);
    sseConnectedBeforeRef.current = false;
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
    // A refusal belongs to the program it was made on.
    setInstantError(null);
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
    rotationVersion.forget();
    setSongSequenceSaveError(null);
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
    /* v8 ignore start -- effects do not run during server rendering, so this guard only exists for an environment where an effect runs with no window */
    if (typeof window === "undefined") {
      return;
    }
    /* v8 ignore stop */
    if (!canUseProgramRealtimeFallback) {
      programRealtimeSocketRef.current?.close();
      programRealtimeSocketRef.current = null;
      setIsProgramRealtimeConnected(false);
      return;
    }

    let disposed = false;
    let reconnectTimer: number | null = null;
    // Whether a socket of this effect has opened before: a later open is a reconnect.
    let openedBefore = false;

    const connect = async () => {
      /* v8 ignore start -- connect is called synchronously by the effect, and the cleanup clears the reconnect timer, so disposed is false on entry */
      if (disposed) {
        return;
      }
      /* v8 ignore stop */

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
        if (openedBefore) resyncWithReachedBackend(activeProgramId);
        openedBefore = true;
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
          rotationVersion.read(payload?.settings);
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
              activeScene: null,
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
          rotationVersion.read(payload?.settings);
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
          rotationVersion.read(payload);
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
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) {
        throw new Error("Scenes answer is not a list");
      }
      setScenes(data as Scene[]);
      setSceneCatalogError(null);
    } catch (err) {
      // Keep the last good list; the message says it may be out of date.
      console.error("Failed to fetch scenes:", err);
      setSceneCatalogError("Scenes could not be loaded. The list may be out of date.");
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
        throw await responseFailure(res);
      }
      const data = (await res.json()) as InstantItem[];
      setInstants(data);
      setInstantsLoadError(null);
    } catch (err) {
      console.error("Failed to fetch instants:", err);
      // The list is the same for every program (it is read without one), so
      // a failed reload keeps the pads that loaded (gaulatti/alcantara#253).
      setInstantsLoadError(failureMessage(err));
    } finally {
      setIsLoadingInstants(false);
    }
  };

  const fetchSongCatalog = async () => {
    try {
      const res = await fetch(apiUrl("/songs?limit=0"));
      if (!res.ok) {
        throw await responseFailure(res);
      }
      const body = (await res.json()) as PaginatedResponse<SongCatalogItem>;
      setSongCatalog(Array.isArray(body.data) ? body.data : []);
      setSongCatalogLoadError(null);
    } catch (err) {
      console.error("Failed to fetch songs catalog:", err);
      // The library is the station's: a failed reload keeps what it had.
      setSongCatalogLoadError(failureMessage(err));
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
    // The levels belong to the program they were set on, and so does the answer: one that arrives after the
    // operator switched program is not applied to the program now on screen (gaulatti/alcantara#682).
    const targetProgramId = activeProgramId;
    setIsSavingMixerLevels(true);
    setMixerSaveError(null);
    try {
      const res = await fetch(
        apiUrl(`/program/${encodeURIComponent(targetProgramId)}/audio-bus`),
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
      if (targetProgramId !== activeProgramIdRef.current) return;
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
      if (targetProgramId !== activeProgramIdRef.current) return;
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
        /* v8 ignore next -- the TV console gives take presets only to non-main channels, so the main channel never reaches its getter */
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
        /* v8 ignore next -- the TV console gives take presets only to non-main channels, so the main channel never reaches its setter */
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
      /* v8 ignore start -- the fade interval is cleared before its run id moves on, so a stale step cannot run */
      if (runId !== takeVolumeFadeRunIdRef.current[channelId]) {
        return;
      }
      /* v8 ignore stop */

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
      // A failed load blanked the rotation, so the next answer is taken even at a version already seen.
      if (!shouldApplyControlUpdatePayload(payload, "audioBus") && !rotationLoadFailedRef.current) {
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
      rotationVersion.read(payload);
      setProgramAudioBusSettings({
        songSequence: normalizedSongSequence,
        songQueue: normalizeProgramSongQueue(payload?.songQueue),
      });
      rotationLoadFailedRef.current = false;
      setRotationLoadFailed(false);
    } catch (err) {
      if (targetProgramId !== activeProgramIdRef.current) {
        return;
      }
      console.error("Failed to fetch program audio bus settings:", err);
      rotationVersion.forget();
      const fallbackMixerLevels = normalizeBroadcastSettingsPayload(null);
      mixerLevelsRef.current = fallbackMixerLevels;
      setMixerLevels(fallbackMixerLevels);
      rotationLoadFailedRef.current = true;
      setRotationLoadFailed(true);
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

  // Retry the rotation every few seconds while its load is failing, until the backend answers (a restart is the usual
  // cause). One retry was not enough: a second failure left the flag set, the effect never ran again, and the desk
  // kept "Couldn't load the rotation" until a reload (walk part 5).
  useEffect(() => {
    if (!rotationLoadFailed) return;
    const retry = window.setInterval(() => {
      void fetchProgramAudioBusSettings(activeProgramId, false);
    }, 3000);
    return () => window.clearInterval(retry);
  }, [rotationLoadFailed, activeProgramId]);

  const saveProgramAudioBusSongSequence = async (
    nextSequence: ProgramSongSequence,
  ) => {
    // The sequence in state is the empty default while the rotation has not loaded: a save would replace the stored
    // rotation. The surfaces show ROTATION_NOT_LOADED on screen, so a save from them is dropped here.
    if (rotationLoadFailed) return;
    // Like the mixer levels, the answer belongs to the program the sequence was saved for (gaulatti/alcantara#682).
    const targetProgramId = activeProgramId;
    const normalizedSongSequence = normalizeProgramSongPlaylist(
      normalizeProgramSongSequence(nextSequence) ?? {
        /* v8 ignore start -- every loader normalises the stored sequence and falls back to an empty manual sequence first, so this fallback cannot receive a null */
        ...createProgramSongSequence("manual"),
        activeItemId: null,
      },
      /* v8 ignore stop */
    );
    setProgramAudioBusSettings((previous) => ({
      ...previous,
      songSequence: normalizedSongSequence,
    }));
    setIsSavingProgramAudioBus(true);
    setSongSequenceSaveError(null);

    try {
      const payload = await rotationVersion.save(async (sequenceVersion) => {
        const res = await fetch(
          apiUrl(`/program/${encodeURIComponent(targetProgramId)}/audio-bus`),
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              songSequence: rotationVersion.shuffleKeepsRows()
                ? normalizedSongSequence
                : rowsAsPlayOrder(normalizedSongSequence),
              sequenceVersion,
            }),
          },
        );
        if (!res.ok) {
          throw await responseFailure(res);
        }
        return (await res.json()) as Partial<ProgramAudioBusSettings> | null;
      });
      if (targetProgramId !== activeProgramIdRef.current) return;
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
      rotationVersion.read(payload);
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
      if (targetProgramId !== activeProgramIdRef.current) return;
      setSongSequenceSaveError(failureMessage(err));
      await fetchProgramAudioBusSettings(targetProgramId, false);
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
    if (!res.ok) throw await responseFailure(res);
    applySongQueueMutationResponse(await res.json(), targetProgramId);
  };

  const removeQueuedProgramSong = async (entryId: string) => {
    const targetProgramId = activeProgramId;
    const res = await authFetch(
      `/program/${encodeURIComponent(targetProgramId)}/song-queue/${encodeURIComponent(entryId)}`,
      { method: "DELETE" },
    );
    // Already gone (the engine took the entry, or another window removed it): there is nothing left to remove.
    if (res.status === 404) return;
    if (!res.ok) throw await responseFailure(res);
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
    if (!res.ok) throw await responseFailure(res);
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
    if (!res.ok) throw await responseFailure(res);
  };

  // A library song that is not in the rotation, on air now: the same command the rotation take
  // posts, without changing the rotation (#298).
  const playLibrarySongNow = async (song: SongCatalogItem) => {
    const res = await fetch(
      apiUrl(`/radio/${encodeURIComponent(activeProgramId)}/song`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioUrl: song.audioUrl,
          title: song.title,
          artist: song.artist,
          coverUrl: song.coverUrl,
          durationMs: song.durationMs,
          songId: song.id,
        }),
      },
    );
    if (!res.ok) throw await responseFailure(res);
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
        throw await responseFailure(res);
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

  // TAKE adds a scene the show does not list yet. A refused or failed add
  // stops the TAKE with the reason, instead of taking a scene the show never
  // accepted; the show's state is reloaded either way.
  const assignSceneToProgram = async (sceneId: number) => {
    let response: Response;
    try {
      response = await fetch(
        apiUrl(`/program/${encodeURIComponent(activeProgramId)}/scenes`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sceneId }),
        },
      );
    } catch (err) {
      console.error("Failed to assign scene to program:", err);
      throw new Error("The scene could not be added to this show. Check the connection and try again.");
    }
    if (!isProgramRealtimeConnected) {
      await fetchProgramState(activeProgramId);
    }
    if (!response.ok) {
      let reason = "";
      try {
        const body = (await response.json()) as { message?: unknown };
        if (typeof body.message === "string") reason = body.message.trim();
      } catch {
        // No readable reason in the answer.
      }
      throw new Error(reason ? `The scene could not be added to this show: ${reason}` : "The scene could not be added to this show.");
    }
  };

  const stageSceneForProgram = async (sceneId: number | null) => {
    // A Preview answer belongs to the program it was asked for: one that arrives after the operator
    // switched program changes nothing on the program now on screen (gaulatti/alcantara#669).
    const targetProgramId = activeProgramId;
    setTakeError(null);
    try {
      const response = await fetch(
        apiUrl(`/program/${encodeURIComponent(targetProgramId)}/stage`),
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
      if (targetProgramId !== activeProgramIdRef.current) return;
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
          /* v8 ignore next -- a stage response always follows the program state the staging control was rendered from, so the state is loaded */
          : previous,
      );

      if (!isProgramRealtimeConnected) {
        await fetchProgramState(targetProgramId);
      }
    } catch (err) {
      if (targetProgramId !== activeProgramIdRef.current) return;
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
    // Like a Preview answer, a fade answer belongs to the program it was sent for (gaulatti/alcantara#669).
    const targetProgramId = activeProgramId;
    try {
      const response = await fetch(
        apiUrl(`/program/${encodeURIComponent(targetProgramId)}/fade-to-black`),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active }),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const nextState = normalizeProgramState(await response.json());
      if (targetProgramId !== activeProgramIdRef.current) return;
      if (nextState) syncProgramStateAndStagedScene(nextState);
    } catch (err) {
      console.error("Failed to change fade-to-black state:", err);
    }
  };

  const saveStagedSceneAttributes = async () => {
    const sceneId = selectedSceneRef.current;
    /* v8 ignore start -- the editor, and its Save changes control, render only for a selected scene */
    if (sceneId === null) {
      return;
    }
    /* v8 ignore stop */

    if (sceneEditorAutosaveTimerRef.current !== null) {
      window.clearTimeout(sceneEditorAutosaveTimerRef.current);
      sceneEditorAutosaveTimerRef.current = null;
    }

    const nextSceneProps = sceneEditorPropsRef.current;
    const nextSignature = JSON.stringify(nextSceneProps);

    setIsSavingSceneAttributes(true);
    setSceneAttributeSaveError(null);
    try {
      if (
        pendingSceneAttributeSaveRef.current ||
        sceneAttributeSaveDrainPromiseRef.current
      ) {
        // Every edit is queued as it is made: a manual save drains that queue rather than sending the same
        // props again, so one edit is one request.
        await flushQueuedSceneAttributeSaves();
      } else if (
        sceneEditorDirtyRef.current ||
        sceneDrainedIdRef.current !== sceneId
      ) {
        await persistSceneAttributes(sceneId, nextSceneProps);
        sceneEditorAutosaveSignatureRef.current = nextSignature;
        sceneEditorDirtyRef.current = false;
        sceneDrainedIdRef.current = sceneId;
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
        /* v8 ignore next -- TAKE BG is disabled without a background audio asset, so the override is always a non-empty asset id */
        : null;
    /* v8 ignore start -- TAKE BG is disabled without a selected scene, and the scene editor only offers it for the selected scene */
    if (normalizedSceneId === null) {
      return;
    }
    /* v8 ignore stop */

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
    const targetProgramId = activeProgramId;
    setInstantError(null);
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
        throw await responseFailure(res);
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
            /* v8 ignore start -- every path that removes a playback entry also clears its timer first, so this timer cannot fire for an entry that is gone */
            if (!prev[instantId]) {
              return prev;
            }
            /* v8 ignore stop */
            const next = { ...prev };
            delete next[instantId];
            return next;
          });
        }, durationMs);
        instantPlaybackTimeoutsRef.current[instantId] = timeoutId;
      }
    } catch (err) {
      console.error("Failed to trigger instant:", err);
      // A refusal for a program the operator has left is not shown.
      if (targetProgramId !== activeProgramIdRef.current) return;
      const name =
        instants.find((instant) => instant.id === instantId)?.name ??
        /* v8 ignore next -- the pad names an instant from the list it was rendered from, so the name is always found */
        "the instant";
      setInstantError(`Could not play ${name}: ${failureMessage(err)}`);
    }
  };

  const stopAllInstants = async () => {
    const targetProgramId = activeProgramId;
    setInstantError(null);
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
        throw await responseFailure(res);
      }

      Object.values(instantPlaybackTimeoutsRef.current).forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      instantPlaybackTimeoutsRef.current = {};
      setInstantPlayback({});
    } catch (err) {
      console.error("Failed to stop all instants:", err);
      if (targetProgramId !== activeProgramIdRef.current) return;
      setInstantError(`Could not stop all instants: ${failureMessage(err)}`);
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
              sceneDrainedIdRef.current = payload.sceneId;
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
      /* v8 ignore start -- the drain loop takes any payload queued while it runs, so this guarantee only applies to a payload queued in the gap between the loop and the settle */
      if (
        pendingSceneAttributeSaveRef.current &&
        !sceneAttributeSaveDrainPromiseRef.current &&
        sceneAttributeRetryTimerRef.current === null
      ) {
        void flushQueuedSceneAttributeSaves().catch(() => {
          // no-op, retry timer is scheduled by flush
        });
      }
      /* v8 ignore stop */
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
          /* v8 ignore start -- a queue starts the drain synchronously, so by the time this zero-millisecond kick fires the drain is running or has taken the payload; the body only covers a missed start */
          if (
            pendingSceneAttributeSaveRef.current &&
            !sceneAttributeSaveDrainPromiseRef.current &&
            sceneAttributeRetryTimerRef.current === null
          ) {
            void flushQueuedSceneAttributeSaves().catch(() => {
              // no-op, retry timer is scheduled by flush
            });
          }
          /* v8 ignore stop */
        }, 0);
      }
    },
    [flushQueuedSceneAttributeSaves],
  );

  const flushSceneAttributeAutosaveForScene = useCallback(
    async (sceneId: number | null) => {
      /* v8 ignore start -- every caller of this flush passes a non-null scene: the editor and the page-hide and blur flushes check selection first, and takeSceneInstant returns early for null */
      if (sceneId === null) {
        return;
      }
      /* v8 ignore stop */

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

    /* v8 ignore start -- React runs the cleanup before every re-run of this effect, and the cleanup clears the pending timer, so no timer is pending here */
    if (sceneEditorAutosaveTimerRef.current !== null) {
      window.clearTimeout(sceneEditorAutosaveTimerRef.current);
    }
    /* v8 ignore stop */

    sceneEditorAutosaveTimerRef.current = window.setTimeout(() => {
      sceneEditorAutosaveTimerRef.current = null;
      /* v8 ignore start -- the effect cleanup clears this timer whenever the selected scene changes, so the callback cannot run with no scene selected */
      if (!selectedSceneRef.current) {
        return;
      }
      /* v8 ignore stop */
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

      const match = event.code.match(/^Digit(\d)$/);
      if (event.ctrlKey && match && Date.now() <= sceneHotkeyArmedUntil) {
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

      // A cart plays on this platform's modifier only (Ctrl on macOS, Alt elsewhere).
      if (!cartModifierHeld(event, platformIsMac())) {
        return;
      }

      const shortcutIndex = getInstantShortcutIndex(key, platformIsMac());
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
  // The last song Palazzo could not load (#175). It stays after the next song
  // starts, so the operator still sees which one was skipped.
  const [radioSongFailure, setRadioSongFailure] = useState<string | null>(null);
  useEffect(() => {
    setRadioPlayoutError(null);
    setRadioSongFailure(null);
  }, [activeProgramId]);

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

      if (data.type === "playout_restart_cut") {
        setRadioSongFailure(playoutCutNotice(data));
        return;
      }
      if (data.type === "song_request_failed") {
        setRadioSongFailure(songRequestFailureNotice(data));
        return;
      }
      if (data.type === "radio_rotation_resume_failed") {
        setRadioPlayoutError(
          "The timed block ended, but continuous fillers could not resume. Check the engine before starting the rotation.",
        );
        return;
      }
      if (data.type === "radio_log_cue_skipped") {
        setRadioPlayoutError(
          "A timed cue was skipped: the engine was unavailable past its one-minute grace. The block goes on with the next cue.",
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
            activeScene: null,
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
        rotationVersion.read(data?.settings);
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
        rotationVersion.read(data);
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

  // The event stream reconnected (connected again after a drop): it may have reached a restarted backend.
  useEffect(() => {
    if (programSseConnectionState !== "connected") return;
    if (sseConnectedBeforeRef.current) resyncWithReachedBackend(activeProgramId);
    sseConnectedBeforeRef.current = true;
    // Only the connection state decides; the show's own change resets the ref and loads it.
  }, [programSseConnectionState]);

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
          /* v8 ignore start -- the stored sequence is already normalised by every loader, which falls back to an empty manual sequence first, so this second fallback cannot receive a null */
          ...createProgramSongSequence("manual"),
          activeItemId: null,
        },
        /* v8 ignore stop */
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
        playoutError={radioPlayoutError ?? radioSongFailure}
        songSequence={programAudioBusSongSequence}
        rotationLoadError={rotationLoadFailed}
        onRetryRotation={() => void fetchProgramAudioBusSettings(activeProgramId)}
        songQueue={normalizeProgramSongQueue(programAudioBusSettings.songQueue)}
        songCatalog={songCatalog}
        programSongPlayback={programSongPlaybackState}
        onSaveSongSequence={async (seq) => {
          // The desk shows a failed save in its own error line, so a refusal is thrown here, not dropped.
          if (rotationLoadFailed) throw new Error(ROTATION_NOT_LOADED);
          await saveProgramAudioBusSongSequence(seq);
        }}
        onTakeSelection={takeProgramSongSelection}
        onQueueSong={enqueueProgramSong}
        onRemoveQueuedSong={removeQueuedProgramSong}
        onReorderSongQueue={reorderProgramSongQueue}
        onTakeOffAir={async () => {
          await takeProgramSongOffAir(activeProgramId);
        }}
        onPlaySongNow={playLibrarySongNow}
        instants={instants}
        instantSearch={instantSearch}
        onInstantSearchChange={setInstantSearch}
        onTriggerInstant={(id) => triggerInstant(id)}
        onStopAllInstants={stopAllInstants}
        instantError={instantError}
        instantsLoadError={instantsLoadError}
        onRetryInstants={() => void fetchInstants()}
        songCatalogLoadError={songCatalogLoadError}
        onRetrySongCatalog={() => void fetchSongCatalog()}
        instantPlayback={instantPlayback}
        mixer={{
          song: {
            volume: mixerLevels.songMasterVolume,
            muted: mixerLevels.songMuted,
            peak: programAudioMeterLevels.song.peak,
            vu: programAudioMeterLevels.song.vu,
            peakHold: programAudioMeterLevels.song.peakHold,
          },
          instants: {
            volume: mixerLevels.instantMasterVolume,
            muted: mixerLevels.instantMuted,
            peak: programAudioMeterLevels.instants.peak,
            vu: programAudioMeterLevels.instants.vu,
            peakHold: programAudioMeterLevels.instants.peakHold,
          },
          main: {
            volume: mixerLevels.mainMasterVolume,
            peak: programAudioMeterLevels.main.peak,
            vu: programAudioMeterLevels.main.vu,
            peakHold: programAudioMeterLevels.main.peakHold,
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
      {sceneCatalogError ? (
        <div role="alert" className="mx-4 mt-3 flex flex-wrap items-center gap-3 rounded-[var(--radius-button)] border border-terracotta/40 bg-terracotta/10 px-3 py-2 text-sm text-terracotta">
          <div className="min-w-0 flex-1 space-y-1">
            <p>{sceneCatalogError}</p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void fetchScenes();
            }}
          >
            Retry
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSceneCatalogError(null);
            }}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
      <BroadcastSwitcherDeck
        notice={
          programState?.type === "both" ? (
            <SimulcastStatusRail programId={activeProgramId} />
          ) : null
        }
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
            programId: activeProgramId,
            sequence: programAudioBusSongSequence,
            songCatalog,
            programSongPlayback: programSongPlaybackState,
            onChange: (next) => {
              // A refused save is shown on screen and the stored rotation is loaded again.
              void saveProgramAudioBusSongSequence(next).catch(() => {});
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
              {recordingOpen && (
                <>
                  <TapePanel programId={activeProgramId} />
                  <RecordingPanel programId={activeProgramId} />
                </>
              )}
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
            {recordingOpen && (
              <>
                <TapePanel programId={activeProgramId} />
                <RecordingPanel programId={activeProgramId} />
              </>
            )}
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
      {songSequenceSaveError && !isPlaylistSheetOpen ? (
        <p role="alert" className="px-3 pt-2 text-sm text-terracotta">
          {songSequenceSaveError}
        </p>
      ) : null}
      {consoleWorkspace === "audio" && rotationLoadFailed ? (
        <div className="px-3 pt-2">
          <RotationLoadNotice onRetry={() => void fetchProgramAudioBusSettings(activeProgramId)} />
        </div>
      ) : null}
      {consoleWorkspace === "audio" && (
        <div className="tv-audio-transport relative z-20 shrink-0">
          <PlaybackBar
            sequence={programAudioBusSongSequence}
            programSongPlayback={programSongPlaybackState}
            onChange={(nextSequence) => {
              // A refused save is shown on screen and the stored rotation is loaded again.
              void saveProgramAudioBusSongSequence(nextSequence).catch(() => {});
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
          />
        </div>
      )}
      <PlaylistSheetPanel
        programId={activeProgramId}
        isOpen={isPlaylistSheetOpen}
        notice={rotationLoadFailed ? <RotationLoadNotice onRetry={() => void fetchProgramAudioBusSettings(activeProgramId)} /> : null}
        onClose={() => setIsPlaylistSheetOpen(false)}
        sequence={programAudioBusSongSequence}
        songCatalog={songCatalog}
        programSongPlayback={programSongPlaybackState}
        isSaving={isSavingProgramAudioBus}
        error={songSequenceSaveError}
        onChange={(nextSequence) => {
          // A refused save is shown on screen and the stored rotation is loaded again.
              void saveProgramAudioBusSongSequence(nextSequence).catch(() => {});
        }}
        /* v8 ignore start -- the sheet renders its editor in catalog view, where the take-on-air buttons are not rendered, so this callback cannot be invoked from the sheet */
        onTakeSelection={async (nextSequence) => {
          /* v8 ignore next -- the sheet's editor renders in catalog view, where its take-on-air buttons are not rendered (the queue block is hidden), so this callback cannot be invoked from the sheet */
          await takeProgramSongSelection(nextSequence);
        }}
        /* v8 ignore stop */
      />
    </div>
  );
}
