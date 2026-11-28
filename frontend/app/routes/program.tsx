import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { PodcastPlayer } from '@gaulatti/bleecker';
import { useSSE } from '../hooks/useSSE';
import { useTransparentDocument } from '../hooks/useTransparentDocument';
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
  ModoItalianoGiorgiaClock,
  ModoItalianoGiorgiaChyron,
  ModoItalianoBracket,
  ModoItalianoGiorgiaPodcastPlayer,
  ModoItalianoGiorgiaArtistBumper,
  CronicaChyron,
  CronicaBackground,
  CronicaReiteramos,
  Slideshow,
  VideoStream,
  WebrtcGuestSource,
  StreamWall,
  Scoreboard
} from '../components';
import RelojClone from '../components/RelojClone';
import { CornerBug } from '@gaulatti/bleecker/components/corner-bug';
import { FadeToBlack } from '@gaulatti/bleecker/components/fade-to-black';
import { FullScreen } from '@gaulatti/bleecker/components/full-screen';
import { LowerThird } from '@gaulatti/bleecker/components/lower-third';
import { SceneNotice } from '@gaulatti/bleecker/components/scene-notice';
import { normalizeSceneComponentTypes, normalizeSceneMetadata, resolveProgramRow } from '../utils/programRow';
import { ModoItalianoProgramRow } from '../components/ModoItalianoProgramRow';
import RelojLoopClock from '../components/RelojLoopClock';
import RelojDigitalLoopClock from '../components/RelojDigitalLoopClock';
import FifthBellProgram from '../components/BrokawFifthBellProgramRenderer';
import { SceneTransitionOverlay } from '../components/SceneTransitionOverlay';
import type { GlobalTimeOverride } from '../utils/broadcastTime';
import {
  ensureProgramAudioBusTrack,
  getProgramAudioBusSnapshot,
  setProgramAudioBusMasterVolume,
  stopProgramAudioBus,
  subscribeProgramAudioBus
} from '../utils/programAudioBus';
import { faderToGain } from '../utils/audioTaper';
import { normalizeProgramSongSequence, resolveProgramSongLeaf, type ProgramSongSequence, type ProgramSongSequenceItem } from '@modoitaliano/giorgia/scenes';
import { resolveToniChyronLeaf } from '../utils/toniChyronSequence';
import { getSceneTransitionPreset, type SceneTransitionPreset } from '../utils/sceneTransitions';
import { loadChartLookup, realtimeChartValues, type ChartFeedLookup } from '../utils/chartFeed';
import { chartLookupId, resolveChartDisplay } from '../utils/programChartValues';
import { getProgramRealtimeSocketUrl } from '../utils/programRealtimeSocket';
import { getProgramSlideshowLabelIds, getProgramSlideshowMediaGroupIds } from '../utils/programSlideshow';
import { sceneInstantBelongsToActiveScene } from '../utils/programSceneInstant';
import { canRouteMediaThroughWebAudio } from '../utils/mediaWebAudioAccess';

import {
  VU_ATTACK_MS,
  VU_RELEASE_MS,
  PEAK_RELEASE_MS,
  PEAK_HOLD_MS,
  METER_TICK_INTERVAL_MS,
  SCENE_INSTANT_SWITCH_FADE_MS,
  normalizeUpdateVersion,
  resolveProgramUpdateTopicFromType,
  readProgramTopicVersion,
  createMeterChannelBallistics,
  createInstantAudioMeterContext,
  flattenProgramSongItems,
  normalizeProgramSongPlaylist,
  normalizeProgramAudioBusSettings,
  normalizeMasterVolume,
  normalizeMixerToggle,
  normalizeSlideshowMediaGroupId,
  normalizeSlideshowLabelId,
  normalizeProgramMixerChannels,
  getProgramMixerChannel,
  normalizeProgramAudioMixerSettings,
  normalizeBroadcastSettings,
  sceneIncludesVideoStream,
  normalizeSceneInstantNumericId,
  normalizeSceneInstantTimestamp,
  normalizeSceneInstantAssetId,
  buildSceneInstantPlaybackToken,
  type Layout,
  type Scene,
  type ProgramState,
  type BroadcastSettings,
  type ProgramMixerChannel,
  type SceneChangeEvent,
  type InstantPlayEvent,
  type SceneInstantTakeEvent,
  type SceneInstantStateEvent,
  type ActiveTransition,
  type InstantAudioRuntimeState,
  type SongOffAirEvent,
  type ProgramReloadEvent,
  type ProgramAudioBusSettings,
  type ProgramAudioMixerSettings,
  type SlideshowMediaItem,
  type SlideshowMediaGroupItem,
  type SlideshowMediaGroup,
  type SlideshowMediaLabel,
  type AudioBusUpdateEvent,
  type MeterChannelPayload,
  type MeterChannelBallistics,
  type ProgramUpdateTopic
} from '../utils/programRuntime';

const FIFTHBELL_DRIVER_COMPONENT_TYPES = new Set(['fifthbell', 'fifthbell-content', 'fifthbell-marquee', 'fifthbell-corner', 'fifthbell-clock']);

/**
 * The on-air page reads each program snapshot with this (gaulatti/alcantara#201).
 * An error answer is refused before it can replace what is on air: the page
 * keeps its last good value, and the console gets one fixed line per source
 * with at most the HTTP status, never the answer's body.
 */
class SnapshotRefused extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

function readSnapshot(res: Response): Promise<unknown> {
  if (!res.ok) throw new SnapshotRefused(res.status);
  return res.json();
}

function keepLastGood(source: string) {
  return (err: unknown) =>
    console.error(
      `[program] ${source} could not be read; keeping the last good value.`,
      err instanceof SnapshotRefused ? `HTTP ${err.status}` : 'unreadable answer',
    );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export default function Program() {
  useTransparentDocument();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const programId = id ?? 'main';
  const confidenceMode = searchParams.get('confidence');
  const rendererMode = searchParams.get('renderer') === '1';

  return (
    <SceneProgram
      programId={programId}
      confidenceMode={confidenceMode === 'preview' ? 'preview' : confidenceMode === 'program' ? 'program' : null}
      suppressGuestAudio={rendererMode}
    />
  );
}

function SceneProgram({ programId, confidenceMode, suppressGuestAudio }: { programId: string; confidenceMode: 'preview' | 'program' | null; suppressGuestAudio: boolean }) {
  const [state, setState] = useState<ProgramState | null>(null);
  const [audioBusSettings, setAudioBusSettings] = useState<ProgramAudioBusSettings | null>(null);
  const [broadcastSettings, setBroadcastSettings] = useState<BroadcastSettings | null>(null);
  const [slideshowMediaGroupsById, setSlideshowMediaGroupsById] = useState<Record<number, SlideshowMediaGroup>>({});
  const [slideshowMediaLabelsById, setSlideshowMediaLabelsById] = useState<Record<string, SlideshowMediaLabel>>({});
  const [programStingers, setProgramStingers] = useState<Array<{ id: number; name: string; videoUrl: string; cutPointMs: number }>>([]);
  const [chartLookup, setChartLookup] = useState<ChartFeedLookup | null>(null);
  const [activeTransition, setActiveTransition] = useState<ActiveTransition | null>(null);
  const [fadeToBlackAudioGain, setFadeToBlackAudioGain] = useState(1);
  const previousFadeToBlackRef = useRef<boolean | null>(null);
  const [bracketDrawCommands, setBracketDrawCommands] = useState<Record<number, any>>({});
  const transitionTimersRef = useRef<number[]>([]);
  const transitionSequenceRef = useRef(0);
  const activeInstantAudiosRef = useRef<Map<HTMLAudioElement, InstantAudioRuntimeState>>(new Map());
  const activeSceneInstantAudioRef = useRef<{
    audio: HTMLAudioElement;
    runtime: InstantAudioRuntimeState;
    playbackToken: string;
    sceneId: number | null;
  } | null>(null);
  const sceneInstantTakeSequenceRef = useRef(0);
  const instantAudioMeterContextRef = useRef<AudioContext | null>(null);
  const programSocketRef = useRef<WebSocket | null>(null);
  const programSocketReadyRef = useRef(false);
  const handleProgramEventRef = useRef<(data: any) => void>(() => {
    // no-op until handler is initialized
  });
  const latestProgramVersionByTopicRef = useRef<Record<ProgramUpdateTopic, number>>({
    state: -1,
    audioBus: -1,
    audioMeter: -1,
    songPlayback: -1,
    sceneInstant: -1,
    broadcastSettings: -1
  });
  // The backend counts update versions in memory, so one that restarted counts from zero again: after a reconnect
  // the versions seen are forgotten, or every update from the new backend would read as old (alcantara#873).
  const forgetProgramVersions = useCallback(() => {
    latestProgramVersionByTopicRef.current = {
      state: -1,
      audioBus: -1,
      audioMeter: -1,
      songPlayback: -1,
      sceneInstant: -1,
      broadcastSettings: -1
    };
  }, []);
  const eventStreamConnectedRef = useRef(false);
  const stingerVideoRefs = useRef<Map<number, HTMLVideoElement>>(new Map());
  const programStingersRef = useRef<Array<{ id: number; name: string; videoUrl: string; cutPointMs: number }>>([]);
  useEffect(() => {
    forgetProgramVersions();
    eventStreamConnectedRef.current = false;
  }, [programId, forgetProgramVersions]);
  const programMixerSettings = useMemo(
    () => (audioBusSettings?.mixerSettings ? normalizeProgramAudioMixerSettings(audioBusSettings.mixerSettings) : normalizeProgramAudioMixerSettings(null)),
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
  const resolvedSongChannelGain = songMuted ? 0 : faderToGain(effectiveSongMasterFader);
  const resolvedInstantChannelGain = instantMuted ? 0 : faderToGain(effectiveInstantMasterFader);
  const resolvedSceneInstantChannelGain = sceneInstantMuted ? 0 : faderToGain(effectiveSceneInstantMasterFader);
  const resolvedStreamChannelGain = streamMuted ? 0 : faderToGain(effectiveStreamMasterFader);
  const mainMasterGain = faderToGain(mainMasterFader);
  const outputGain = confidenceMode ? 0 : fadeToBlackAudioGain;
  const resolvedSongMasterVolume = normalizeMasterVolume(resolvedSongChannelGain * mainMasterGain * outputGain, 0);
  const resolvedInstantMasterVolume = normalizeMasterVolume(resolvedInstantChannelGain * mainMasterGain * outputGain, 0);
  const resolvedSceneInstantMasterVolume = normalizeMasterVolume(resolvedSceneInstantChannelGain * mainMasterGain * outputGain, 0);
  const resolvedStreamMasterVolume = normalizeMasterVolume(resolvedStreamChannelGain * mainMasterGain * outputGain, 0);
  useEffect(() => {
    if (confidenceMode) {
      setFadeToBlackAudioGain(0);
      return;
    }

    const target = state?.fadeToBlack ? 0 : 1;
    if (!state || previousFadeToBlackRef.current === null) {
      setFadeToBlackAudioGain(target);
      if (state) previousFadeToBlackRef.current = state.fadeToBlack === true;
      return;
    }
    let animationFrame = 0;
    const startedAt = performance.now();
    const startGain = fadeToBlackAudioGain;
    const renderFrame = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / 1000);
      setFadeToBlackAudioGain(startGain + (target - startGain) * progress);
      if (progress < 1) {
        animationFrame = window.requestAnimationFrame(renderFrame);
      }
    };
    animationFrame = window.requestAnimationFrame(renderFrame);
    previousFadeToBlackRef.current = state.fadeToBlack === true;
    return () => window.cancelAnimationFrame(animationFrame);
  }, [confidenceMode, state?.fadeToBlack]);
  const resolvedManualSong = useMemo(
    () => (normalizedSongSequence?.mode === 'manual' ? resolveProgramSongLeaf({ sequence: normalizedSongSequence }) : null),
    [normalizedSongSequence]
  );
  const slideshowMediaGroupIds = useMemo(
    () => getProgramSlideshowMediaGroupIds(state?.activeScene, state?.stagedScene),
    [
      state?.activeScene?.id,
      state?.activeScene?.metadata,
      state?.activeScene?.layout?.componentType,
      state?.stagedScene?.id,
      state?.stagedScene?.metadata,
      state?.stagedScene?.layout?.componentType
    ]
  );
  const slideshowMediaLabelIds = useMemo(
    () => getProgramSlideshowLabelIds(state?.activeScene, state?.stagedScene),
    [
      state?.activeScene?.id,
      state?.activeScene?.metadata,
      state?.activeScene?.layout?.componentType,
      state?.stagedScene?.id,
      state?.stagedScene?.metadata,
      state?.stagedScene?.layout?.componentType
    ]
  );
  // A long-running program output must refresh even when two scenes reuse the
  // same group ID or the active scene's slideshow configuration is edited.
  const slideshowMediaGroupRequestKey = [
    slideshowMediaGroupIds.join(','),
    state?.activeScene?.id ?? '',
    state?.activeScene?.metadata ?? '',
    state?.stagedScene?.id ?? '',
    state?.stagedScene?.metadata ?? ''
  ].join('|');
  const slideshowMediaLabelRequestKey = [
    slideshowMediaLabelIds.join(','),
    state?.activeScene?.id ?? '',
    state?.activeScene?.metadata ?? '',
    state?.stagedScene?.id ?? '',
    state?.stagedScene?.metadata ?? ''
  ].join('|');

  const resolveSlideshowImages = useCallback(
    (slideshowProps: Record<string, unknown>): unknown => {
      const labelId = normalizeSlideshowLabelId(slideshowProps.labelId);
      if (labelId !== null) {
        const label = slideshowMediaLabelsById[labelId];
        return label
          ? [...label.images]
              .sort((a, b) => a.position - b.position)
              .map((image) => image.imageUrl)
              .filter((imageUrl): imageUrl is string => typeof imageUrl === 'string' && imageUrl.trim().length > 0)
          : [];
      }

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
    [slideshowMediaGroupsById, slideshowMediaLabelsById]
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
        const stream =
          (
            audio as HTMLAudioElement & {
              captureStream?: () => MediaStream;
            }
          ).captureStream?.() ||
          (
            audio as HTMLAudioElement & {
              mozCaptureStream?: () => MediaStream;
            }
          ).mozCaptureStream?.();
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
        // Web Audio cannot read a cross-origin source loaded without CORS: routing it would mute the
        // element and play silence. It keeps playing on its own, without a level.
        if (context.state !== 'running' || !canRouteMediaThroughWebAudio(audio)) {
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

  const stopSceneInstantAudio = useCallback((fadeMs = 0) => {
    const current = activeSceneInstantAudioRef.current;
    if (!current) {
      return;
    }
    const { audio, runtime } = current;

    if (fadeMs > 0) {
      if (activeSceneInstantAudioRef.current === current) {
        activeSceneInstantAudioRef.current = null; // Detach immediately to prevent volume jumps from settings changes
      }

      const initialVolume = audio.volume;
      const startTime = performance.now();

      const fadeStep = (timestamp: number) => {
        const elapsed = timestamp - startTime;
        if (elapsed >= fadeMs) {
          audio.volume = 0;
          audio.pause();
          try {
            audio.currentTime = 0;
          } catch {
            // no-op
          }
          audio.onended = null;
          audio.onerror = null;
          if (runtime.meterSource) {
            try {
              runtime.meterSource.disconnect();
            } catch {
              // ignore
            }
          }
          if (runtime.meterAnalyser) {
            try {
              runtime.meterAnalyser.disconnect();
            } catch {
              // no-op
            }
          }
          return;
        }

        audio.volume = Math.max(0, initialVolume * (1 - elapsed / fadeMs));
        requestAnimationFrame(fadeStep);
      };

      requestAnimationFrame(fadeStep);
      return;
    }

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
      if (!event.instant) {
        // A take with no instant has nothing to play. Refuse it before it cancels a take in progress.
        console.warn(`Scene instant take ignored: no instant on scene ${event.sceneId}`);
        return;
      }
      sceneInstantTakeSequenceRef.current += 1;
      const takeSequence = sceneInstantTakeSequenceRef.current;
      const sceneId = normalizeSceneInstantNumericId(event.sceneId);
      const instantId = normalizeSceneInstantNumericId(event.instant?.id);
      const mediaAssetId = normalizeSceneInstantAssetId(event.instant?.assetId);
      const timestamp = normalizeSceneInstantTimestamp(event.triggeredAt);
      const audioUrl = typeof event.instant?.audioUrl === 'string' ? event.instant.audioUrl.trim() : '';
      const playbackToken = buildSceneInstantPlaybackToken(sceneId, mediaAssetId, instantId, audioUrl, timestamp);
      const currentlyPlayingSceneInstant = activeSceneInstantAudioRef.current;

      if (
        currentlyPlayingSceneInstant &&
        currentlyPlayingSceneInstant.playbackToken === playbackToken &&
        !currentlyPlayingSceneInstant.audio.paused &&
        !currentlyPlayingSceneInstant.audio.ended
      ) {
        return;
      }

      const startSceneInstantPlayback = () => {
        if (sceneInstantTakeSequenceRef.current !== takeSequence) {
          return;
        }

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
        activeSceneInstantAudioRef.current = { audio, runtime, playbackToken, sceneId };

        const playPromise = audio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch((err) => {
            console.error(`Failed to play scene instant "${event.instant.name}":`, err);
            cleanup();
          });
        }
      };

      if (currentlyPlayingSceneInstant && !currentlyPlayingSceneInstant.audio.paused && !currentlyPlayingSceneInstant.audio.ended) {
        stopSceneInstantAudio(SCENE_INSTANT_SWITCH_FADE_MS);
        window.setTimeout(() => {
          startSceneInstantPlayback();
        }, SCENE_INSTANT_SWITCH_FADE_MS);
        return;
      }

      stopSceneInstantAudio();
      startSceneInstantPlayback();
    },
    [ensureInstantAudioMeter, resolvedSceneInstantMasterVolume, stopSceneInstantAudio]
  );

  useEffect(() => {
    const current = activeSceneInstantAudioRef.current;
    if (!current) return;
    const activeSceneId = normalizeSceneInstantNumericId(state?.activeSceneId);
    if (!sceneInstantBelongsToActiveScene(current.sceneId, activeSceneId)) {
      sceneInstantTakeSequenceRef.current += 1;
      stopSceneInstantAudio(SCENE_INSTANT_SWITCH_FADE_MS);
    }
  }, [state?.activeSceneId, stopSceneInstantAudio]);

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

  const performProgramFullReload = useCallback(() => {
    /* v8 ignore start -- this full reload runs from a user action in the browser, where a window always exists */
    if (typeof window === 'undefined') {
      return;
    }
    /* v8 ignore stop */

    const reloadWithCacheBust = () => {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set('_reload', Date.now().toString());
      window.location.replace(nextUrl.toString());
    };

    if (!('caches' in window)) {
      reloadWithCacheBust();
      return;
    }

    void window.caches
      .keys()
      .then((keys) => Promise.all(keys.map((key) => window.caches.delete(key))))
      .catch((err) => {
        console.warn('Failed to clear CacheStorage before program reload:', err);
      })
      .finally(() => {
        reloadWithCacheBust();
      });
  }, []);

  const shouldApplyProgramUpdatePayload = useCallback((payload: unknown, topicOverride?: ProgramUpdateTopic): boolean => {
    const topic =
      topicOverride ?? (payload && typeof payload === 'object' && !Array.isArray(payload) ? resolveProgramUpdateTopicFromType((payload as Record<string, unknown>).type) : null);
    if (!topic) {
      return true;
    }

    const nextVersion = readProgramTopicVersion(topic, payload);
    if (nextVersion === null) {
      return true;
    }

    const previousVersion = latestProgramVersionByTopicRef.current[topic] ?? -1;
    if (nextVersion <= previousVersion) {
      return false;
    }

    latestProgramVersionByTopicRef.current[topic] = nextVersion;
    return true;
  }, []);

  const handleProgramEvent = useCallback(
    (data: any) => {
      if (!data || typeof data !== 'object') {
        return;
      }

      if (!shouldApplyProgramUpdatePayload(data)) {
        return;
      }

      if (data.type === 'program_state_snapshot') {
        if (data.state && typeof data.state === 'object') {
          setState(data.state as ProgramState);
        }
      } else if (data.type === 'audio_bus_snapshot') {
        setAudioBusSettings(normalizeProgramAudioBusSettings(data.settings));
      } else if (data.type === 'broadcast_settings_snapshot') {
        setBroadcastSettings(normalizeBroadcastSettings(data.settings));
      } else if (data.type === 'fade_to_black') {
        if (data.state && typeof data.state === 'object') {
          setState(data.state as ProgramState);
        }
      } else if (data.type === 'scene_staged') {
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
        let preset = getSceneTransitionPreset(event.transitionId);

        if (preset.id === 'webm-stinger') {
          const stingers = programStingersRef.current;
          const firstStinger = stingers.length > 0 ? stingers[0] : null;
          if (firstStinger) {
            const cutPointMs = firstStinger.cutPointMs ?? 1000;
            preset = {
              ...preset,
              stingerUrl: firstStinger.videoUrl,
              cutPointMs,
              durationMs: cutPointMs + 2000
            };
          }
        }

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
          if (!prev || !data.scene) return prev;
          return {
            ...prev,
            activeScene: prev.activeScene?.id === data.scene.id ? data.scene : prev.activeScene,
            stagedScene: prev.stagedScene?.id === data.scene.id ? data.scene : prev.stagedScene
          };
        });
      } else if (data.type === 'modoitaliano_bracket_draw_start') {
        if (typeof data.sceneId !== 'number' || !Array.isArray(data.songIds)) {
          return;
        }
        setBracketDrawCommands((previous) => ({
          ...previous,
          [data.sceneId]: {
            id: data.drawId,
            seed: data.drawId,
            startedAt: Date.now(),
            durationSeconds: data.durationSeconds,
            songIds: data.songIds,
            selectedSongId: null
          }
        }));
      } else if (data.type === 'modoitaliano_bracket_draw_end') {
        setBracketDrawCommands((previous) => {
          const current = previous[data.sceneId];
          if (!current || current.id !== data.drawId) return previous;
          const next = { ...previous };
          delete next[data.sceneId];
          return next;
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
        if (confidenceMode) return;
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
        if (confidenceMode) return;
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
        stopSceneInstantAudio(data.fadeMs || 0);
      } else if (data.type === 'scene_instant_state') {
        if (confidenceMode) return;
        const event = data as SceneInstantStateEvent;
        const eventProgramId = typeof event.programId === 'string' ? event.programId : '';
        if (eventProgramId && eventProgramId !== programId) {
          return;
        }
        const playback = event.playback;
        if (playback && playback.isPlaying && playback.instant && typeof playback.instant.audioUrl === 'string' && playback.instant.audioUrl.trim().length > 0) {
          const sceneId = normalizeSceneInstantNumericId(playback.sceneId);
          const instantId = normalizeSceneInstantNumericId(playback.instant.id);
          const mediaAssetId = normalizeSceneInstantAssetId(playback.mediaAssetId ?? playback.instant.assetId);
          const timestamp = normalizeSceneInstantTimestamp(playback.startedAt) || normalizeSceneInstantTimestamp(playback.updatedAt);
          const playbackToken = buildSceneInstantPlaybackToken(sceneId, mediaAssetId, instantId, playback.instant.audioUrl, timestamp);
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
          // Decision (gaulatti/alcantara#264): the state poll is the source of truth. A poll that answers
          // isPlaying:false stops an instant, even one a websocket take started a moment earlier. The
          // race is resolved by the next poll, which answers from the backend, so the page does not keep
          // a grace window of its own. A grace window, if wanted, is a separate ticket. The
          // playing-answer case is pinned by the scene-instant tests.
          stopSceneInstantAudio();
        }
      } else if (data.type === 'program_reload') {
        const event = data as ProgramReloadEvent;
        const eventProgramId = typeof event.programId === 'string' ? event.programId : '';
        if (eventProgramId && eventProgramId !== programId) {
          return;
        }
        performProgramFullReload();
      } else if (data.type === 'song_off_air') {
        const event = data as SongOffAirEvent;
        if (event.programId === programId) {
          stopProgramAudioBus(programId);
        }
      } else if (data.type === 'song_playback_update') {
        // The console's Preview and Program monitors are pictures only. Without this, each monitor
        // started the song on its own audio bus at full volume, so the console played it twice with
        // no way to turn it off.
        if (confidenceMode) return;
        const playback = data?.playback;
        if (playback && playback.audioUrl && playback.isPlaying) {
          const audioUrl = String(playback.audioUrl).trim();
          if (audioUrl) {
            const token = String(playback.token || `${Date.now()}:${audioUrl}`).trim();
            const snapshot = getProgramAudioBusSnapshot(programId);
            if (snapshot.track?.token !== token || !snapshot.isPlaying) {
              ensureProgramAudioBusTrack(programId, {
                token,
                audioUrl,
                durationMs: typeof playback.durationMs === 'number' ? playback.durationMs : undefined,
                artist: typeof playback.artist === 'string' ? playback.artist : undefined,
                title: typeof playback.title === 'string' ? playback.title : undefined
              });
            }
          }
        } else if (playback && !playback.isPlaying) {
          stopProgramAudioBus(programId);
        }
      } else if (data.type === 'audio_bus_update') {
        const event = data as AudioBusUpdateEvent;
        if (event.programId === programId) {
          setAudioBusSettings(normalizeProgramAudioBusSettings(event.settings));
        }
      } else if (data.type === 'program_stingers_changed') {
        const eventProgramId = typeof data.programId === 'string' ? data.programId : '';
        if (eventProgramId && eventProgramId !== programId) {
          return;
        }
        if (data.state && typeof data.state === 'object' && Array.isArray(data.state.stingers)) {
          const stingers = data.state.stingers.map((entry: any) => ({
            id: entry.stingerId,
            name: entry.stinger?.name || '',
            videoUrl: entry.stinger?.videoUrl || '',
            cutPointMs: entry.stinger?.cutPointMs ?? 1000
          }));
          setProgramStingers(stingers);
          programStingersRef.current = stingers;
        } else {
          fetch(apiUrl(`/program/${encodeURIComponent(programId)}/stingers`))
            .then(readSnapshot)
            .then((stingers) => {
              if (!Array.isArray(stingers)) throw new Error('not a list');
              setProgramStingers(stingers);
              programStingersRef.current = stingers;
            })
            .catch(keepLastGood('Program stingers reload'));
        }
      }
    },
    [
      programId,
      confidenceMode,
      state?.activeScene,
      state?.activeSceneId,
      playInstantAudio,
      stopAllInstantAudio,
      stopSceneInstantAudio,
      takeSceneInstantAudio,
      clearTransitionTimers,
      performProgramFullReload,
      shouldApplyProgramUpdatePayload
    ]
  );

  useEffect(() => {
    handleProgramEventRef.current = handleProgramEvent;
  }, [handleProgramEvent]);

  useEffect(() => {
    programStingersRef.current = programStingers;
  }, [programStingers]);

  useEffect(() => {
    const currentRefs = stingerVideoRefs.current;
    const seen = new Set<number>();

    for (const stinger of programStingers) {
      seen.add(stinger.id);
      if (!currentRefs.has(stinger.id)) {
        const video = document.createElement('video');
        video.src = stinger.videoUrl;
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.style.display = 'none';
        document.body.appendChild(video);
        currentRefs.set(stinger.id, video);
      }
    }

    // A stinger that left the list releases its video. The others keep theirs, so a transition in
    // progress still finds the video it needs and an unchanged stinger is not fetched again.
    for (const [id, video] of currentRefs) {
      if (!seen.has(id)) {
        video.removeAttribute('src');
        video.load();
        if (video.parentNode) {
          video.parentNode.removeChild(video);
        }
        currentRefs.delete(id);
      }
    }
  }, [programStingers]);

  useEffect(() => {
    const currentRefs = stingerVideoRefs.current;
    return () => {
      for (const [, video] of currentRefs) {
        video.removeAttribute('src');
        video.load();
        if (video.parentNode) {
          video.parentNode.removeChild(video);
        }
      }
      currentRefs.clear();
    };
  }, []);

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
    let cancelled = false;
    const fallbackTimer = window.setTimeout(() => {
      /* v8 ignore start -- the effect cleanup clears this timer as well as setting cancelled, so the callback cannot run after cleanup */
      if (cancelled) {
        return;
      }
      /* v8 ignore stop */

      fetch(apiUrl(`/program/${encodeURIComponent(programId)}/state`))
        .then(readSnapshot)
        .then((data) => {
          if (!cancelled && isRecord(data) && shouldApplyProgramUpdatePayload(data, 'state')) {
            setState(data as unknown as ProgramState);
          }
        })
        .catch(keepLastGood('Initial program state'));

      fetch(apiUrl(`/program/${encodeURIComponent(programId)}/audio-bus`))
        .then(readSnapshot)
        .then((data) => {
          if (!cancelled && shouldApplyProgramUpdatePayload(data, 'audioBus')) {
            setAudioBusSettings(normalizeProgramAudioBusSettings(data));
          }
        })
        .catch(keepLastGood('Initial audio bus'));

      fetch(apiUrl('/program/broadcast-settings'))
        .then(readSnapshot)
        .then((data) => {
          if (!cancelled && shouldApplyProgramUpdatePayload(data, 'broadcastSettings')) {
            setBroadcastSettings(normalizeBroadcastSettings(data));
          }
        })
        .catch(keepLastGood('Initial broadcast settings'));

      fetch(apiUrl(`/program/${encodeURIComponent(programId)}/scene-instant`))
        .then(readSnapshot)
        .then((playback) => {
          if (!cancelled) {
            const sceneInstantVersion =
              playback && typeof playback === 'object' && !Array.isArray(playback) ? normalizeUpdateVersion((playback as Record<string, unknown>).version) : null;
            handleProgramEventRef.current({
              type: 'scene_instant_state',
              programId,
              playback,
              version: sceneInstantVersion ?? undefined
            });
          }
        })
        .catch(keepLastGood('Initial scene clip playback'));

      fetch(apiUrl(`/program/${encodeURIComponent(programId)}/stingers`))
        .then(readSnapshot)
        .then((stingers) => {
          if (!Array.isArray(stingers)) throw new Error('not a list');
          if (!cancelled) {
            setProgramStingers(stingers);
            programStingersRef.current = stingers;
          }
        })
        .catch(keepLastGood('Initial program stingers'));
    }, 900);

    return () => {
      cancelled = true;
      window.clearTimeout(fallbackTimer);
    };
  }, [programId, shouldApplyProgramUpdatePayload]);

  useEffect(() => {
    let cancelled = false;

    const pollSnapshots = () => {
      fetch(apiUrl(`/program/${encodeURIComponent(programId)}/state`))
        .then(readSnapshot)
        .then((data) => {
          if (!cancelled && isRecord(data) && shouldApplyProgramUpdatePayload(data, 'state')) {
            setState(data as unknown as ProgramState);
          }
        })
        .catch(keepLastGood('Program state poll'));

      fetch(apiUrl(`/program/${encodeURIComponent(programId)}/audio-bus`))
        .then(readSnapshot)
        .then((data) => {
          if (!cancelled && shouldApplyProgramUpdatePayload(data, 'audioBus')) {
            setAudioBusSettings(normalizeProgramAudioBusSettings(data));
          }
        })
        .catch(keepLastGood('Audio bus poll'));

      fetch(apiUrl('/program/broadcast-settings'))
        .then(readSnapshot)
        .then((data) => {
          if (!cancelled && shouldApplyProgramUpdatePayload(data, 'broadcastSettings')) {
            setBroadcastSettings(normalizeBroadcastSettings(data));
          }
        })
        .catch(keepLastGood('Broadcast settings poll'));

      fetch(apiUrl(`/program/${encodeURIComponent(programId)}/scene-instant`))
        .then(readSnapshot)
        .then((playback) => {
          if (!cancelled) {
            const sceneInstantVersion =
              playback && typeof playback === 'object' && !Array.isArray(playback) ? normalizeUpdateVersion((playback as Record<string, unknown>).version) : null;
            handleProgramEventRef.current({
              type: 'scene_instant_state',
              programId,
              playback,
              version: sceneInstantVersion ?? undefined
            });
          }
        })
        .catch(keepLastGood('Scene clip playback poll'));

      fetch(apiUrl(`/program/${encodeURIComponent(programId)}/stingers`))
        .then(readSnapshot)
        .then((stingers) => {
          if (!Array.isArray(stingers)) throw new Error('not a list');
          if (!cancelled) {
            setProgramStingers(stingers);
            programStingersRef.current = stingers;
          }
        })
        .catch(keepLastGood('Program stingers poll'));
    };

    const pollTimer = window.setInterval(() => {
      pollSnapshots();
    }, 5000);

    pollSnapshots();

    return () => {
      cancelled = true;
      window.clearInterval(pollTimer);
    };
  }, [programId, shouldApplyProgramUpdatePayload]);

  useEffect(() => {
    // Also applied in a console monitor, where the resolved volume is 0, so a monitor's bus can
    // never be audible even if something starts a track on it.
    setProgramAudioBusMasterVolume(programId, resolvedSongMasterVolume);
  }, [programId, resolvedSongMasterVolume]);

  useEffect(() => {
    if (confidenceMode) {
      return;
    }
    let lastEndedToken = '';

    return subscribeProgramAudioBus(programId, (snapshot) => {
      if (!snapshot.track || !snapshot.endedToken || snapshot.endedToken === lastEndedToken) {
        return;
      }

      lastEndedToken = snapshot.endedToken;
      const socket = programSocketRef.current;
      if (!socket || !programSocketReadyRef.current || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      try {
        socket.send(JSON.stringify({ type: 'song_ended', programId }));
      } catch {
        // The flight timeout remains the fallback if the connection drops at song end.
      }
    });
  }, [confidenceMode, programId]);

  useEffect(() => {
    if (confidenceMode || !audioBusSettings || normalizedSongSequence?.mode !== 'manual') {
      return;
    }

    const song = resolvedManualSong;
    const audioUrl = song?.audioUrl?.trim() ?? '';
    const snapshot = getProgramAudioBusSnapshot(programId);

    if (!song || !audioUrl) {
      if (snapshot.track) {
        stopProgramAudioBus(programId);
      }
      return;
    }

    const token = `manual:${song.id}:${audioUrl}`;
    if (snapshot.track?.token === token && snapshot.isPlaying) {
      return;
    }

    ensureProgramAudioBusTrack(programId, {
      token,
      audioUrl,
      durationMs: song.durationMs,
      artist: song.artist,
      title: song.title,
      coverUrl: song.coverUrl,
      earoneSongId: song.earoneSongId,
      earoneRank: song.earoneRank,
      earoneSpins: song.earoneSpins
    });
  }, [
    programId,
    confidenceMode,
    audioBusSettings,
    normalizedSongSequence?.mode,
    resolvedManualSong?.id,
    resolvedManualSong?.audioUrl,
    resolvedManualSong?.artist,
    resolvedManualSong?.title,
    resolvedManualSong?.coverUrl,
    resolvedManualSong?.durationMs,
    resolvedManualSong?.earoneSongId,
    resolvedManualSong?.earoneRank,
    resolvedManualSong?.earoneSpins
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
    if (!slideshowMediaGroupIds.length) {
      return;
    }

    let cancelled = false;

    Promise.all(
      slideshowMediaGroupIds.map(async (mediaGroupId) => {
        const res = await fetch(apiUrl(`/media-groups/${mediaGroupId}`));
        if (!res.ok) {
          throw new Error(`Media group ${mediaGroupId}: HTTP ${res.status}`);
        }
        return (await res.json()) as SlideshowMediaGroup;
      })
    )
      .then((payloads) => {
        if (cancelled) return;
        setSlideshowMediaGroupsById((prev) => {
          const next = { ...prev };
          payloads.forEach((payload) => {
            next[payload.id] = payload;
          });
          return next;
        });
      })
      .catch((err) => console.error('Failed to load slideshow media groups:', err));

    return () => {
      cancelled = true;
    };
  }, [slideshowMediaGroupRequestKey]);

  useEffect(() => {
    if (!slideshowMediaLabelIds.length) return;

    let cancelled = false;
    Promise.all(
      slideshowMediaLabelIds.map(async (labelId) => {
        const res = await fetch(apiUrl(`/media-labels/${encodeURIComponent(labelId)}/images`));
        if (!res.ok) throw new Error(`Media label ${labelId}: HTTP ${res.status}`);
        return (await res.json()) as SlideshowMediaLabel;
      })
    )
      .then((payloads) => {
        if (cancelled) return;
        setSlideshowMediaLabelsById((prev) => {
          const next = { ...prev };
          payloads.forEach((payload) => {
            next[payload.id] = payload;
          });
          return next;
        });
      })
      .catch((err) => console.error('Failed to load slideshow media labels:', err));

    return () => {
      cancelled = true;
    };
  }, [slideshowMediaLabelRequestKey]);

  useEffect(() => {
    if (confidenceMode || typeof window === 'undefined') {
      return;
    }

    let disposed = false;
    let reconnectTimer: number | null = null;
    let openedBefore = false;

    const connect = () => {
      /* v8 ignore start -- connect is called synchronously by its effect, and the cleanup clears the reconnect timer, so disposed is false on entry */
      if (disposed) {
        return;
      }
      /* v8 ignore stop */

      let socket: WebSocket;
      try {
        socket = new WebSocket(getProgramRealtimeSocketUrl(programId, 'program'));
      } catch {
        reconnectTimer = window.setTimeout(connect, 1500);
        return;
      }

      programSocketRef.current = socket;
      programSocketReadyRef.current = false;

      socket.addEventListener('open', () => {
        if (disposed || programSocketRef.current !== socket) {
          socket.close();
          return;
        }
        programSocketReadyRef.current = true;
        if (openedBefore) forgetProgramVersions();
        openedBefore = true;
      });

      socket.addEventListener('close', () => {
        if (programSocketRef.current === socket) {
          programSocketRef.current = null;
          programSocketReadyRef.current = false;
        }
        if (!disposed) {
          reconnectTimer = window.setTimeout(connect, 1500);
        }
      });

      socket.addEventListener('error', () => socket.close());
    };

    connect();

    return () => {
      disposed = true;
      programSocketReadyRef.current = false;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      const socket = programSocketRef.current;
      programSocketRef.current = null;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    };
  }, [confidenceMode, programId]);

  useEffect(() => {
    const componentTypes = state?.activeScene?.layout.componentType.split(',').filter(Boolean) || [];
    const needsEaroneRealtime = componentTypes.includes('earone');

    if (!needsEaroneRealtime) {
      return;
    }

    let cancelled = false;

    const loadEarone = async () => {
      try {
        const lookup = await loadChartLookup();
        if (!cancelled) {
          setChartLookup(lookup);
        }
      } catch (err) {
        console.error('Failed to fetch the chart feed:', err);
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
    onConnectionStateChange: (connection) => {
      if (connection !== 'connected') return;
      if (eventStreamConnectedRef.current) forgetProgramVersions();
      eventStreamConnectedRef.current = true;
    },
    enabled: true
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
      return <SceneNotice message='No Active Scene' />;
    }

    // A retired chyron or clock id renders through its Giorgia replacement, with the props stored under either key.
    const storedComponents = scene.layout.componentType
      .split(',')
      .map((componentType) => componentType.trim())
      .filter(Boolean);
    const components = normalizeSceneComponentTypes(storedComponents);

    // Parse metadata
    let metadata: any = {};
    try {
      metadata = scene.metadata ? JSON.parse(scene.metadata) : {};
    } catch (err) {
      console.error('Failed to parse scene metadata:', err);
    }
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      metadata = normalizeSceneMetadata(metadata, storedComponents);
    }

    const mergedFifthBellChyronProps = {
      ...(metadata['toni-chyron'] || {}),
      ...(metadata['fifthbell-chyron'] || {})
    } as Record<string, unknown>;
    const activeToniLeaf = resolveToniChyronLeaf(mergedFifthBellChyronProps);
    const firstClockComponentType = components.find(
      (componentType) => componentType === 'toni-clock' || componentType === 'fifthbell-clock' || componentType === 'fifthbell-corner'
    );
    const fifthBellClockProps = {
      ...(metadata['fifthbell'] || {}),
      ...(metadata['fifthbell-corner'] || {}),
      ...(metadata['fifthbell-clock'] || {}),
      ...(metadata['toni-clock'] || {})
    } as Record<string, unknown>;
    const programRow = resolveProgramRow(components);
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
          hashtag={props.hashtag || ''}
          url={props.url || ''}
          chyronText={props.chyronText || ''}
          showChyron={Boolean(props.showChyron ?? !!props.chyronText)}
          qrCodeContent={props.qrCodeContent || ''}
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
          const zIndex = props.zIndex !== undefined && props.zIndex !== '' ? Number(props.zIndex) : undefined;

          const renderComponent = (): React.ReactNode => {
            switch (componentType) {
              case 'ticker':
                return (
                  <div
                    key={componentType}
                    style={{
                      position: 'absolute',
                      bottom: 0,
                      left: 0,
                      right: 0
                    }}
                  >
                    <Ticker hashtag={props.hashtag || '#Default'} url={props.url || 'website.com'} />
                  </div>
                );
              case 'chyron':
                return (
                  <div
                    key={componentType}
                    style={{
                      position: 'absolute',
                      bottom: '120px',
                      left: 0,
                      right: 0
                    }}
                  >
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
              case 'stream-wall':
                return (
                  <StreamWall
                    key={componentType}
                    urls={Array.isArray(props.urls) ? props.urls : []}
                    maxStreams={typeof props.maxStreams === 'number' ? props.maxStreams : 4}
                    title={typeof props.title === 'string' ? props.title : ''}
                    suspended={outputGain <= 0.0001}
                  />
                );
              case 'webrtc-guest':
                return (
                  <WebrtcGuestSource
                    key={componentType}
                    programId={programId}
                    slotNumber={props.slotNumber}
                    objectFit={props.objectFit}
                    showStatus={props.showStatus}
                    suppressAudio={suppressGuestAudio}
                    channelGain={options?.forceStreamMuted ? 0 : resolvedStreamMasterVolume}
                  />
                );
              case 'scoreboard':
                return (
                  <Scoreboard
                    key={componentType}
                    title={props.title}
                    homeTeam={props.homeTeam}
                    awayTeam={props.awayTeam}
                    homeScore={props.homeScore}
                    awayScore={props.awayScore}
                    period={props.period}
                    showPeriod={typeof props.showPeriod === 'boolean' ? props.showPeriod : true}
                    clock={props.clock}
                    showClock={typeof props.showClock === 'boolean' ? props.showClock : true}
                    status={props.status}
                  />
                );
              case 'reloj-clock':
                return <RelojClone key={componentType} timezone={props.timezone || 'America/Argentina/Buenos_Aires'} logoUrl={props.logoUrl} timeOverride={globalTimeOverride} />;
              case 'reloj-loop-clock':
                return <RelojLoopClock key={componentType} timezone={props.timezone || 'Europe/Madrid'} />;
              case 'reloj-digital-loop-clock':
                return (
                  <RelojDigitalLoopClock
                    key={componentType}
                    timezone={props.timezone || 'America/New_York'}
                    textSequence={props.textSequence}
                    ctaSequence={props.ctaSequence}
                    programId={programId}
                    mode={props.mode || 'clock'}
                    countdownDuration={typeof props.countdownDuration === 'number' ? props.countdownDuration : 300}
                    countdownTargetSceneId={typeof props.countdownTargetSceneId === 'number' ? props.countdownTargetSceneId : null}
                    countdownTransitionId={props.countdownTransitionId || 'cut'}
                    countdownCommand={typeof props.countdownCommand === 'number' ? props.countdownCommand : 0}
                    allowProgramActivation={!confidenceMode}
                  />
                );
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
                    contentMode={fifthBellChyronProps.contentMode === 'text' || fifthBellChyronProps.contentMode === 'sequence' ? fifthBellChyronProps.contentMode : undefined}
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
                    rotationIntervalMs={typeof fifthBellClockProps.worldClockRotateIntervalMs === 'number' ? fifthBellClockProps.worldClockRotateIntervalMs : undefined}
                    transitionDurationMs={typeof fifthBellClockProps.worldClockTransitionMs === 'number' ? fifthBellClockProps.worldClockTransitionMs : undefined}
                    shuffleCities={typeof fifthBellClockProps.worldClockShuffle === 'boolean' ? fifthBellClockProps.worldClockShuffle : undefined}
                    widthPx={typeof fifthBellClockProps.worldClockWidthPx === 'number' ? fifthBellClockProps.worldClockWidthPx : undefined}
                    showWorldClocks={typeof fifthBellClockProps.showWorldClocks === 'boolean' ? fifthBellClockProps.showWorldClocks : undefined}
                    showBellIcon={resolvedShowBellIcon}
                  />
                );
              case 'modoitaliano-giorgia-clock':
                if (programRow?.ownedTypes.has(componentType)) {
                  return null;
                }
                return (
                  <ModoItalianoGiorgiaClock
                    key={componentType}
                    programId={programId}
                    timeOverride={globalTimeOverride}
                    transitionDurationMs={300}
                    shuffleCities={false}
                    widthPx={220}
                    showWorldClocks={toBoolean(props.showWorldClocks, true)}
                    showLogo={toBoolean(props.showLogo, true)}
                    showPlaybackProgress={toBoolean(props.showPlaybackProgress, true)}
                    showBellIcon={false}
                    songSequence={audioBusSettings?.songSequence}
                    language='es'
                    keySafe={toBoolean(props.keySafe, false)}
                  />
                );
              case 'modoitaliano-giorgia-chyron':
                if (programRow?.ownedTypes.has(componentType)) {
                  return null;
                }
                return (
                  <ModoItalianoGiorgiaChyron
                    key={componentType}
                    show={typeof props.show === 'boolean' ? props.show : true}
                    textSequence={props.textSequence}
                    ctaSequence={props.ctaSequence}
                    keySafe={toBoolean(props.keySafe, false)}
                  />
                );
              // The bracket under its Giorgia id is the same component: the legacy id stays for stored scenes.
              case 'modoitaliano-giorgia-bracket':
                return (
                  <ModoItalianoBracket
                    key={componentType}
                    title={props.title}
                    show={typeof props.show === 'boolean' ? props.show : true}
                    startRound={props.startRound}
                    matches={Array.isArray(props.matches) ? props.matches : []}
                    drawCommand={bracketDrawCommands[scene.id]}
                    voters={props.voters}
                    matchVotes={props.matchVotes}
                    activeVotingMatchId={props.activeVotingMatchId}
                    votingWinnerId={props.votingWinnerId}
                    votingResultStartedAt={props.votingResultStartedAt}
                  />
                );
              // The generic player from Bleecker: same id and props as the legacy scene, so stored scenes keep working.
              case 'modoitaliano-podcast-player':
                return (
                  <PodcastPlayer
                    key={componentType}
                    show={typeof props.show === 'boolean' ? props.show : true}
                    coverUrl={typeof props.coverUrl === 'string' ? props.coverUrl : ''}
                    episodeTitle={typeof props.episodeTitle === 'string' ? props.episodeTitle : ''}
                    showName={typeof props.showName === 'string' ? props.showName : ''}
                    audioUrl={typeof props.audioUrl === 'string' ? props.audioUrl : ''}
                    masterGain={outputGain}
                  />
                );
              case 'modoitaliano-giorgia-podcast-player':
                return (
                  <ModoItalianoGiorgiaPodcastPlayer
                    key={componentType}
                    show={typeof props.show === 'boolean' ? props.show : true}
                    coverUrl={typeof props.coverUrl === 'string' ? props.coverUrl : ''}
                    episodeTitle={typeof props.episodeTitle === 'string' ? props.episodeTitle : ''}
                    showName={typeof props.showName === 'string' ? props.showName : ''}
                    audioUrl={typeof props.audioUrl === 'string' ? props.audioUrl : ''}
                    masterGain={outputGain}
                  />
                );
              case 'modoitaliano-giorgia-artist-bumper':
                return (
                  <ModoItalianoGiorgiaArtistBumper
                    key={componentType}
                    show={typeof props.show === 'boolean' ? props.show : true}
                    artist={props.artist}
                    songTitle={props.songTitle}
                    labelId={props.labelId}
                    images={props.images}
                    contentType={props.contentType}
                    creditLines={props.creditLines}
                  />
                );
              case 'toni-logo':
                return <ToniLogo key={componentType} callsign={props.callsign || ''} subtitle={props.subtitle} />;
              case 'earone': {
                const realtimeChart = realtimeChartValues(chartLookup, {
                  id: chartLookupId(activeToniLeaf?.earoneSongId, activeToniLeaf),
                  text: activeToniLeaf?.text || null
                });
                const chartDisplay = resolveChartDisplay({
                  scene: { rank: props.rank, spins: props.spins },
                  song: activeToniLeaf,
                  realtime: realtimeChart,
                  legacy: { rank: activeToniLeaf?.earoneRank, spins: activeToniLeaf?.earoneSpins }
                });
                return <Earone key={componentType} label={props.label || 'EARONE'} rank={chartDisplay.rank} spins={chartDisplay.spins} />;
              }
              case 'fifthbell':
              case 'fifthbell-content':
              case 'fifthbell-marquee':
                if (firstFifthBellComponentType !== componentType) {
                  return null;
                }
                return (
                  <div key={componentType} className='absolute inset-0'>
                    <FifthBellProgram programId={programId} embedded sceneMetadata={metadata} activeComponents={components} masterGain={outputGain} />
                  </div>
                );
              case 'corner-bug':
                return (
                  <div key={componentType} style={{ position: 'absolute', top: '32px', right: '32px' }}>
                    <CornerBug text={props.text} />
                  </div>
                );
              case 'cronica-background':
                return <CronicaBackground key={componentType} />;
              case 'cronica-chyron':
                return <CronicaChyron key={componentType} text={props.text} />;
              case 'cronica-reiteramos':
                return <CronicaReiteramos key={componentType} text={props.text} show={props.show} />;
              default:
                console.warn('Unknown component type:', componentType);
                return <SceneNotice key={componentType} message={`Unknown component: ${componentType}`} variant='component' />;
            }
          };

          const rendered = renderComponent();
          if (rendered === null || rendered === undefined) return null;
          if (zIndex === undefined) return rendered;
          return (
            <div key={componentType} style={{ position: 'absolute', inset: 0, zIndex }}>
              {rendered}
            </div>
          );
        })}
        {programRow && (
          <ModoItalianoProgramRow
            plan={programRow}
            metadata={metadata}
            programId={programId}
            timeOverride={globalTimeOverride}
            songSequence={audioBusSettings?.songSequence}
          />
        )}
      </div>
    );
  };

  const activeScene = state?.activeScene ?? null;
  const stagedScene = state?.stagedScene ?? null;
  const confidenceScene = confidenceMode === 'preview' ? stagedScene : activeScene;
  // A staged scene with a video stream is rendered hidden and muted, so its stream is
  // already playing when it goes on air (gaulatti/alcantara#357). Both scenes are keyed
  // by id under one parent: a take swaps them (the staged one goes on air and the one
  // it replaces is staged), and the keyed layer keeps its mounted tree, so a cut shows
  // a live frame instead of a cold stream starting over black.
  const warmStagedScene =
    stagedScene !== null && sceneIncludesVideoStream(stagedScene) && stagedScene.id !== activeScene?.id ? stagedScene : null;
  const sceneLayers = [
    ...(activeScene ? [{ scene: activeScene, onAir: true }] : []),
    ...(warmStagedScene ? [{ scene: warmStagedScene, onAir: false }] : [])
  ].sort((a, b) => a.scene.id - b.scene.id);
  const shouldAnimateFadeToBlack = previousFadeToBlackRef.current !== null;

  if (confidenceMode) {
    return (
      <div className='relative overflow-hidden bg-black' style={{ width: '1920px', height: '1080px' }} data-confidence-monitor={confidenceMode}>
        <div className='absolute inset-0'>{renderScene(confidenceScene, { forceStreamMuted: true })}</div>
        {/* The monitor's black layer carries its own marker, so a check for the program's never finds this one. */}
        {confidenceMode === 'program' ? (
          <FadeToBlack
            data-fade-to-black={undefined}
            data-confidence-fade-to-black={state?.fadeToBlack ? 'active' : 'inactive'}
            active={Boolean(state?.fadeToBlack)}
            animate={shouldAnimateFadeToBlack}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className='relative overflow-hidden bg-transparent' style={{ width: '1920px', height: '1080px' }}>
      {activeScene ? null : <div className='absolute inset-0'>{renderScene(null, { forceStreamMuted: false })}</div>}
      {sceneLayers.map(({ scene, onAir }) => (
        <div
          key={scene.id}
          data-scene-layer={onAir ? 'on-air' : 'staged'}
          className={onAir ? 'absolute inset-0' : 'pointer-events-none absolute inset-0'}
          aria-hidden={onAir ? undefined : true}
          style={{ opacity: onAir ? 1 : 0, zIndex: onAir ? 1 : 0 }}
        >
          {renderScene(scene, { forceStreamMuted: !onAir })}
        </div>
      ))}
      {activeTransition && <SceneTransitionOverlay key={activeTransition.sequence} transition={activeTransition.preset} />}
      <FadeToBlack active={Boolean(state?.fadeToBlack)} animate={shouldAnimateFadeToBlack} />
    </div>
  );
}
