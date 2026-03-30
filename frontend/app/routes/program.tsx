import { useCallback, useEffect, useRef, useState } from 'react';
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
  ToniChyron,
  ToniClock,
  ToniLogo,
  Earone,
  ModoItalianoClock,
  ModoItalianoChyron,
  ModoItalianoDisclaimer,
  Slideshow
} from '../components';
import RelojClone from '../components/RelojClone';
import RelojLoopClock from '../components/RelojLoopClock';
import FifthBellProgram from '../programs/fifthbell/FifthBellProgram.tsx';
import { SceneTransitionOverlay } from '../components/SceneTransitionOverlay';
import type { GlobalTimeOverride } from '../utils/broadcastTime';
import { getProgramAudioBusSignalLevel, setProgramAudioBusMasterVolume, stopProgramAudioBus } from '../utils/programAudioBus';
import { faderToGain } from '../utils/audioTaper';
import { normalizeProgramSongSequence, type ProgramSongSequence, type ProgramSongSequenceItem } from '../utils/programSequence';
import { resolveToniChyronLeaf } from '../utils/toniChyronSequence';
import { getSceneTransitionPreset, type SceneTransitionPreset } from '../utils/sceneTransitions';
import { BACKEND_SANREMO_REALTIME_URL, buildEaroneRealtimeLookup, matchEaroneRealtimeEntry, type EaroneRealtimeLookup } from '../utils/earoneRealtime';

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
  activeSceneId: number | null;
  activeScene: Scene | null;
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
  songMuted: boolean;
  instantMuted: boolean;
  songSolo: boolean;
  instantSolo: boolean;
  updatedAt: string;
}

interface SceneChangeEvent {
  type: 'scene_change';
  transitionId?: string | null;
  state: ProgramState;
}

interface InstantPlayEvent {
  type: 'instant_play';
  instant: {
    id: number;
    name: string;
    audioUrl: string;
    volume: number;
  };
  triggeredAt: string;
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
}

interface AudioBusUpdateEvent {
  type: 'audio_bus_update';
  programId: string;
  settings: ProgramAudioBusSettings;
  updatedAt: string;
}

const FIFTHBELL_DRIVER_COMPONENT_TYPES = new Set(['fifthbell', 'fifthbell-content', 'fifthbell-marquee', 'fifthbell-corner']);
const FIFTHBELL_LAYOUT_COMPONENT_TYPES = new Set([...FIFTHBELL_DRIVER_COMPONENT_TYPES, 'toni-clock']);

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
    return { songSequence: null };
  }

  const record = value as Record<string, unknown>;
  const normalizedSongSequence = normalizeProgramSongSequence(record.songSequence);

  return {
    songSequence: normalizedSongSequence ? normalizeProgramSongPlaylist(normalizedSongSequence) : null
  };
}

function normalizeMasterVolume(value: unknown, fallback: number = 1): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  return fallback;
}

function normalizeBroadcastSettings(value: unknown): BroadcastSettings | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'number' && Number.isFinite(record.id) ? record.id : 1;
  return {
    id,
    timeOverrideEnabled: Boolean(record.timeOverrideEnabled),
    timeOverrideStartTime: typeof record.timeOverrideStartTime === 'string' ? record.timeOverrideStartTime : null,
    timeOverrideStartedAt: typeof record.timeOverrideStartedAt === 'string' ? record.timeOverrideStartedAt : null,
    mainMasterVolume: normalizeMasterVolume(record.mainMasterVolume, 1),
    songMasterVolume: normalizeMasterVolume(record.songMasterVolume, 1),
    instantMasterVolume: normalizeMasterVolume(record.instantMasterVolume, 1),
    songMuted: Boolean(record.songMuted),
    instantMuted: Boolean(record.instantMuted),
    songSolo: Boolean(record.songSolo),
    instantSolo: Boolean(record.instantSolo),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString()
  };
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
  const [earoneLookup, setEaroneLookup] = useState<EaroneRealtimeLookup | null>(null);
  const [activeTransition, setActiveTransition] = useState<ActiveTransition | null>(null);
  const transitionTimersRef = useRef<number[]>([]);
  const transitionSequenceRef = useRef(0);
  const activeInstantAudiosRef = useRef<Map<HTMLAudioElement, InstantAudioRuntimeState>>(new Map());
  const instantAudioMeterContextRef = useRef<AudioContext | null>(null);
  const lastMeterPayloadRef = useRef<{ song: number; instants: number; main: number }>({
    song: 0,
    instants: 0,
    main: 0
  });
  const mainMasterFader = normalizeMasterVolume(broadcastSettings?.mainMasterVolume, 1);
  const songMasterVolume = normalizeMasterVolume(broadcastSettings?.songMasterVolume, 1);
  const instantMasterVolume = normalizeMasterVolume(broadcastSettings?.instantMasterVolume, 1);
  const songMuted = Boolean(broadcastSettings?.songMuted);
  const instantMuted = Boolean(broadcastSettings?.instantMuted);
  const songSolo = Boolean(broadcastSettings?.songSolo);
  const instantSolo = Boolean(broadcastSettings?.instantSolo);
  const hasSoloChannel = songSolo || instantSolo;
  const effectiveSongMasterFader = hasSoloChannel ? (songSolo ? songMasterVolume : 0) : songMasterVolume;
  const effectiveInstantMasterFader = hasSoloChannel ? (instantSolo ? instantMasterVolume : 0) : instantMasterVolume;
  const resolvedSongChannelGain = songMuted ? 0 : faderToGain(effectiveSongMasterFader);
  const resolvedInstantChannelGain = instantMuted ? 0 : faderToGain(effectiveInstantMasterFader);
  const mainMasterGain = faderToGain(mainMasterFader);
  const resolvedSongMasterVolume = normalizeMasterVolume(resolvedSongChannelGain * mainMasterGain, 0);
  const resolvedInstantMasterVolume = normalizeMasterVolume(resolvedInstantChannelGain * mainMasterGain, 0);

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
          audio.captureStream?.() ||
          (audio as HTMLAudioElement & { mozCaptureStream?: () => MediaStream }).mozCaptureStream?.();
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

  const readInstantSignalLevel = useCallback((): number => {
    let peak = 0;
    for (const [audio, runtime] of activeInstantAudiosRef.current) {
      if (audio.paused || audio.ended) {
        continue;
      }
      if (!runtime.meterAnalyser || !runtime.meterBuffer) {
        continue;
      }

      runtime.meterAnalyser.getFloatTimeDomainData(runtime.meterBuffer);
      let sumSquares = 0;
      for (let index = 0; index < runtime.meterBuffer.length; index += 1) {
        const sample = runtime.meterBuffer[index];
        sumSquares += sample * sample;
      }
      const rms = Math.sqrt(sumSquares / runtime.meterBuffer.length);
      if (rms > peak) {
        peak = rms;
      }
    }

    return Math.max(0, Math.min(1, peak));
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

  useEffect(() => {
    transitionTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    transitionTimersRef.current = [];
    setActiveTransition(null);
    setState(null);
    setAudioBusSettings(null);
    stopAllInstantAudio();

    fetch(apiUrl(`/program/${encodeURIComponent(programId)}/state`))
      .then((res) => res.json())
      .then((data) => setState(data))
      .catch((err) => console.error('Failed to fetch initial state:', err));

    fetch(apiUrl(`/program/${encodeURIComponent(programId)}/audio-bus`))
      .then((res) => res.json())
      .then((data) => setAudioBusSettings(normalizeProgramAudioBusSettings(data)))
      .catch((err) => console.error('Failed to fetch audio bus settings:', err));
  }, [programId]);

  useEffect(() => {
    return () => {
      transitionTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      transitionTimersRef.current = [];
      stopAllInstantAudio();
      const context = instantAudioMeterContextRef.current;
      instantAudioMeterContextRef.current = null;
      if (context && context.state !== 'closed') {
        void context.close().catch(() => {
          // no-op
        });
      }
    };
  }, []);

  useEffect(() => {
    fetch(apiUrl('/program/broadcast-settings'))
      .then((res) => res.json())
      .then((data) => setBroadcastSettings(normalizeBroadcastSettings(data)))
      .catch((err) => console.error('Failed to fetch broadcast settings:', err));
  }, []);

  useEffect(() => {
    setProgramAudioBusMasterVolume(programId, resolvedSongMasterVolume);
  }, [programId, resolvedSongMasterVolume]);

  useEffect(() => {
    for (const [audio, runtime] of activeInstantAudiosRef.current) {
      audio.volume = normalizeMasterVolume(runtime.baseVolume * resolvedInstantMasterVolume, 1);
    }
  }, [resolvedInstantMasterVolume]);

  useEffect(() => {
    let isDisposed = false;
    let requestInFlight = false;

    const sendMeterPayload = async (payload: { song: number; instants: number; main: number }) => {
      if (requestInFlight || isDisposed) {
        return;
      }
      requestInFlight = true;

      try {
        await fetch(apiUrl(`/program/${encodeURIComponent(programId)}/audio-meter`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch {
        // silent fail: meter updates are best effort only
      } finally {
        requestInFlight = false;
      }
    };

    const tick = () => {
      const songSignal = getProgramAudioBusSignalLevel(programId);
      const instantsSignal = readInstantSignalLevel();
      const mainSignal = Math.max(0, Math.min(1, Math.sqrt(songSignal * songSignal + instantsSignal * instantsSignal)));
      const nextPayload = {
        song: songSignal,
        instants: instantsSignal,
        main: mainSignal
      };
      const previousPayload = lastMeterPayloadRef.current;
      const changed =
        Math.abs(nextPayload.song - previousPayload.song) > 0.012 ||
        Math.abs(nextPayload.instants - previousPayload.instants) > 0.012 ||
        Math.abs(nextPayload.main - previousPayload.main) > 0.012;

      if (!changed) {
        return;
      }

      lastMeterPayloadRef.current = nextPayload;
      void sendMeterPayload(nextPayload);
    };

    tick();
    const meterTimer = window.setInterval(tick, 120);

    return () => {
      isDisposed = true;
      window.clearInterval(meterTimer);
      const silentPayload = { song: 0, instants: 0, main: 0 };
      lastMeterPayloadRef.current = silentPayload;
      void fetch(apiUrl(`/program/${encodeURIComponent(programId)}/audio-meter`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(silentPayload),
        keepalive: true
      }).catch(() => {
        // ignore cleanup reporting errors
      });
    };
  }, [programId, readInstantSignalLevel]);

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
    onMessage: (data) => {
      if (data.type === 'scene_change') {
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
        playInstantAudio(data as InstantPlayEvent);
      } else if (data.type === 'instant_stop_all') {
        stopAllInstantAudio();
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
    }
  });

  const globalTimeOverride: GlobalTimeOverride | null =
    broadcastSettings?.timeOverrideEnabled && !!broadcastSettings.timeOverrideStartTime && !!broadcastSettings.timeOverrideStartedAt
      ? {
          startTime: broadcastSettings.timeOverrideStartTime,
          startedAt: broadcastSettings.timeOverrideStartedAt
        }
      : null;

  const renderScene = (scene: Scene | null) => {
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

    const activeToniLeaf = resolveToniChyronLeaf(metadata['toni-chyron'] || {});
    const matchedEaroneEntry = matchEaroneRealtimeEntry(earoneLookup, {
      earoneSongId: activeToniLeaf?.earoneSongId || null,
      text: activeToniLeaf?.text || null
    });
    const hasOnlyFifthBellComponents =
      components.length > 0 &&
      components.every((componentType) => FIFTHBELL_LAYOUT_COMPONENT_TYPES.has(componentType)) &&
      components.some((componentType) => FIFTHBELL_DRIVER_COMPONENT_TYPES.has(componentType));
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

    if (hasOnlyFifthBellComponents) {
      return (
        <div className='absolute inset-0'>
          <FifthBellProgram programId={programId} embedded sceneMetadata={metadata} activeComponents={components} />
        </div>
      );
    }

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
                  images={props.images}
                  intervalMs={props.intervalMs}
                  transitionMs={props.transitionMs}
                  shuffle={props.shuffle}
                  fitMode={props.fitMode}
                  kenBurns={props.kenBurns}
                />
              );
            case 'reloj-clock':
              return <RelojClone key={componentType} timezone={props.timezone || 'America/Argentina/Buenos_Aires'} timeOverride={globalTimeOverride} />;
            case 'reloj-loop-clock':
              return <RelojLoopClock key={componentType} timezone={props.timezone || 'Europe/Madrid'} />;
            case 'toni-chyron':
              return (
                <ToniChyron
                  key={componentType}
                  text={props.text || ''}
                  show={true}
                  useMarquee={props.useMarquee}
                  contentMode={props.contentMode}
                  sequence={props.sequence}
                />
              );
            case 'toni-clock':
              return (
                <ToniClock
                  key={componentType}
                  timeOverride={globalTimeOverride}
                  cities={Array.isArray(props.worldClockCities) ? props.worldClockCities : undefined}
                  rotationIntervalMs={typeof props.worldClockRotateIntervalMs === 'number' ? props.worldClockRotateIntervalMs : undefined}
                  transitionDurationMs={typeof props.worldClockTransitionMs === 'number' ? props.worldClockTransitionMs : undefined}
                  shuffleCities={typeof props.worldClockShuffle === 'boolean' ? props.worldClockShuffle : undefined}
                  widthPx={typeof props.worldClockWidthPx === 'number' ? props.worldClockWidthPx : undefined}
                  showWorldClocks={typeof props.showWorldClocks === 'boolean' ? props.showWorldClocks : undefined}
                  showBellIcon={typeof props.showBellIcon === 'boolean' ? props.showBellIcon : undefined}
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
            case 'fifthbell-corner':
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

  return (
    <div className='relative overflow-hidden bg-transparent' style={{ width: '1920px', height: '1080px' }}>
      {renderScene(state?.activeScene ?? null)}
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
