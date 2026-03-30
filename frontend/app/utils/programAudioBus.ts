import { interpolateGainLog } from './audioTaper';

export interface ProgramAudioBusTrack {
  token: string;
  audioUrl: string;
  durationMs?: number;
  artist?: string;
  title?: string;
  coverUrl?: string;
  earoneSongId?: string;
  earoneRank?: string;
  earoneSpins?: string;
}

export interface ProgramAudioBusSnapshot {
  track: ProgramAudioBusTrack | null;
  progress: number;
  endedToken: string;
  isPlaying: boolean;
}

type Listener = (snapshot: ProgramAudioBusSnapshot) => void;

interface ProgramAudioBusState {
  activeTrack: ProgramAudioBusTrack | null;
  activeAudio: HTMLAudioElement | null;
  masterVolume: number;
  progress: number;
  endedToken: string;
  isPlaying: boolean;
  transitionVersion: number;
  listeners: Set<Listener>;
  meterContext: AudioContext | null;
  meterSource: AudioNode | null;
  meterAnalyser: AnalyserNode | null;
  meterBuffer: Float32Array | null;
  lastSignalLevel: number;
  meterUsesMediaElementFallback: boolean;
}

const audioBusByProgram = new Map<string, ProgramAudioBusState>();
const AUDIO_FADE_OUT_MS = 420;
const AUDIO_FADE_IN_MS = 320;
const AUDIO_FADE_STEP_MS = 20;
const AUDIO_TARGET_VOLUME = 1;

function createProgramAudioBusState(): ProgramAudioBusState {
  return {
    activeTrack: null,
    activeAudio: null,
    masterVolume: 1,
    progress: 0,
    endedToken: '',
    isPlaying: false,
    transitionVersion: 0,
    listeners: new Set<Listener>(),
    meterContext: null,
    meterSource: null,
    meterAnalyser: null,
    meterBuffer: null,
    lastSignalLevel: 0,
    meterUsesMediaElementFallback: false
  };
}

function normalizeProgramId(programId: string): string {
  return typeof programId === 'string' ? programId.trim() : '';
}

function getProgramAudioBusState(programId: string, createIfMissing: boolean): ProgramAudioBusState | null {
  const normalizedProgramId = normalizeProgramId(programId);
  if (!normalizedProgramId) {
    return null;
  }

  const existing = audioBusByProgram.get(normalizedProgramId);
  if (existing) {
    return existing;
  }

  if (!createIfMissing) {
    return null;
  }

  const created = createProgramAudioBusState();
  audioBusByProgram.set(normalizedProgramId, created);
  return created;
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) {
    return AUDIO_TARGET_VOLUME;
  }
  return Math.max(0, Math.min(AUDIO_TARGET_VOLUME, value));
}

function getAudioProgress(audio: HTMLAudioElement): number {
  const duration = Number(audio.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  return clampProgress(audio.currentTime / duration);
}

function getSnapshot(state: ProgramAudioBusState): ProgramAudioBusSnapshot {
  return {
    track: state.activeTrack,
    progress: state.progress,
    endedToken: state.endedToken,
    isPlaying: state.isPlaying
  };
}

function emit(state: ProgramAudioBusState): void {
  const snapshot = getSnapshot(state);
  state.listeners.forEach((listener) => {
    listener(snapshot);
  });
}

function clearAudioBindings(audio: HTMLAudioElement): void {
  audio.onplay = null;
  audio.onpause = null;
  audio.ontimeupdate = null;
  audio.onloadedmetadata = null;
  audio.onended = null;
  audio.onerror = null;
}

function releaseAudioMeter(state: ProgramAudioBusState): void {
  if (state.meterUsesMediaElementFallback && state.activeAudio) {
    state.activeAudio.muted = false;
  }
  if (state.meterSource) {
    try {
      state.meterSource.disconnect();
    } catch {
      // no-op
    }
    state.meterSource = null;
  }
  if (state.meterAnalyser) {
    try {
      state.meterAnalyser.disconnect();
    } catch {
      // no-op
    }
    state.meterAnalyser = null;
  }
  state.meterBuffer = null;
  state.lastSignalLevel = 0;
  state.meterUsesMediaElementFallback = false;
}

function setupAudioMeter(state: ProgramAudioBusState, audio: HTMLAudioElement): void {
  releaseAudioMeter(state);
  if (typeof window === 'undefined') {
    return;
  }

  const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    return;
  }

  try {
    const context = state.meterContext ?? new AudioContextCtor();
    state.meterContext = context;
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
      state.meterSource = source;
      state.meterAnalyser = analyser;
      state.meterBuffer = new Float32Array(analyser.fftSize);
      state.meterUsesMediaElementFallback = false;
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
      state.meterSource = source;
      state.meterAnalyser = analyser;
      state.meterBuffer = new Float32Array(analyser.fftSize);
      state.meterUsesMediaElementFallback = true;
      return true;
    };

    if (attachFromStream()) {
      if (context.state === 'suspended') {
        void context.resume().catch(() => {
          // ignore resume failures; meter can recover on next track
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
          if (state.activeAudio !== audio || state.meterSource) {
            return;
          }
          try {
            void attachFromMediaElement();
          } catch {
            // no-op
          }
        })
        .catch(() => {
          // ignore resume failures; some environments require user gesture
        });
    }
  } catch {
    releaseAudioMeter(state);
  }
}

function detachAndStopAudio(audio: HTMLAudioElement): void {
  clearAudioBindings(audio);
  audio.pause();
  try {
    audio.currentTime = 0;
  } catch {
    // no-op
  }
}

function fadeAudioVolume(
  audio: HTMLAudioElement,
  from: number,
  to: number,
  durationMs: number,
  shouldContinue: () => boolean
): Promise<void> {
  const normalizedFrom = clampVolume(from);
  const normalizedTo = clampVolume(to);
  audio.volume = normalizedFrom;

  if (durationMs <= 0 || normalizedFrom === normalizedTo) {
    audio.volume = normalizedTo;
    return Promise.resolve();
  }

  const steps = Math.max(1, Math.round(durationMs / AUDIO_FADE_STEP_MS));
  return new Promise((resolve) => {
    let step = 0;
    const timer = window.setInterval(() => {
      if (!shouldContinue()) {
        window.clearInterval(timer);
        resolve();
        return;
      }

      step += 1;
      const ratio = Math.min(1, step / steps);
      audio.volume = clampVolume(interpolateGainLog(normalizedFrom, normalizedTo, ratio));

      if (ratio >= 1) {
        window.clearInterval(timer);
        resolve();
      }
    }, AUDIO_FADE_STEP_MS);
  });
}

function setActiveAudio(state: ProgramAudioBusState, audio: HTMLAudioElement, trackToken: string): void {
  audio.preload = 'auto';
  setupAudioMeter(state, audio);

  audio.onplay = () => {
    state.isPlaying = true;
    emit(state);
  };

  audio.onpause = () => {
    if (!audio.ended) {
      state.isPlaying = false;
      emit(state);
    }
  };

  audio.onloadedmetadata = () => {
    state.progress = getAudioProgress(audio);
    emit(state);
  };

  audio.ontimeupdate = () => {
    state.progress = getAudioProgress(audio);
    emit(state);
  };

  audio.onended = () => {
    state.progress = 1;
    state.isPlaying = false;
    state.endedToken = trackToken;
    emit(state);
  };

  audio.onerror = () => {
    state.isPlaying = false;
    emit(state);
  };

  state.activeAudio = audio;
}

function replaceTrack(state: ProgramAudioBusState, track: ProgramAudioBusTrack): void {
  if (state.activeAudio) {
    releaseAudioMeter(state);
    detachAndStopAudio(state.activeAudio);
    state.activeAudio = null;
  }

  state.activeTrack = track;
  state.progress = 0;
  state.endedToken = '';
  state.isPlaying = false;

  const audio = new Audio(track.audioUrl);
  audio.volume = clampVolume(state.masterVolume);
  setActiveAudio(state, audio, track.token);
  emit(state);

  const playPromise = audio.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch((err) => {
      console.error(`Failed to start audio bus track "${track.audioUrl}"`, err);
      state.isPlaying = false;
      emit(state);
    });
  }
}

async function transitionToTrackWithFade(state: ProgramAudioBusState, track: ProgramAudioBusTrack): Promise<void> {
  state.transitionVersion += 1;
  const version = state.transitionVersion;
  const outgoingAudio = state.activeAudio;

  if (outgoingAudio && !outgoingAudio.ended) {
    const startVolume = clampVolume(outgoingAudio.volume);
    await fadeAudioVolume(outgoingAudio, startVolume, 0, AUDIO_FADE_OUT_MS, () => version === state.transitionVersion);
  }

  if (version !== state.transitionVersion) {
    return;
  }

  if (outgoingAudio) {
    releaseAudioMeter(state);
    detachAndStopAudio(outgoingAudio);
    if (state.activeAudio === outgoingAudio) {
      state.activeAudio = null;
    }
  }

  state.activeTrack = track;
  state.progress = 0;
  state.endedToken = '';
  state.isPlaying = false;

  const incomingAudio = new Audio(track.audioUrl);
  incomingAudio.volume = 0;
  setActiveAudio(state, incomingAudio, track.token);
  emit(state);

  try {
    const playPromise = incomingAudio.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      await playPromise;
    }
  } catch (err) {
    console.error(`Failed to start audio bus track "${track.audioUrl}"`, err);
    state.isPlaying = false;
    emit(state);
    return;
  }

  if (version !== state.transitionVersion) {
    return;
  }

  const targetVolume = clampVolume(state.masterVolume);
  await fadeAudioVolume(incomingAudio, incomingAudio.volume, targetVolume, AUDIO_FADE_IN_MS, () => version === state.transitionVersion);

  if (version !== state.transitionVersion) {
    return;
  }
  incomingAudio.volume = targetVolume;
}

export function ensureProgramAudioBusTrack(programId: string, track: ProgramAudioBusTrack): void {
  const state = getProgramAudioBusState(programId, true);
  if (!state) {
    return;
  }

  const normalizedToken = track.token.trim();
  const normalizedUrl = track.audioUrl.trim();
  if (!normalizedToken || !normalizedUrl) {
    return;
  }

  const normalizedTrack: ProgramAudioBusTrack = {
    ...track,
    token: normalizedToken,
    audioUrl: normalizedUrl
  };

  if (state.activeTrack && state.activeTrack.token === normalizedTrack.token && state.activeAudio) {
    if (!state.activeAudio.ended && state.activeAudio.paused) {
      const playPromise = state.activeAudio.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {
          // keep existing track state; no hard failure for autoplay restrictions
        });
      }
    }
    emit(state);
    return;
  }

  const hasRunningTrack = state.activeTrack && state.activeAudio && !state.activeAudio.ended && !state.activeAudio.paused;
  if (hasRunningTrack) {
    void transitionToTrackWithFade(state, normalizedTrack);
    return;
  }

  state.transitionVersion += 1;
  replaceTrack(state, normalizedTrack);
}

export function stopProgramAudioBus(programId: string): void {
  const state = getProgramAudioBusState(programId, false);
  if (!state) {
    return;
  }

  state.transitionVersion += 1;

  if (state.activeAudio) {
    releaseAudioMeter(state);
    detachAndStopAudio(state.activeAudio);
    state.activeAudio = null;
  }

  state.activeTrack = null;
  state.progress = 0;
  state.endedToken = '';
  state.isPlaying = false;
  emit(state);
}

export function setProgramAudioBusMasterVolume(programId: string, volume: number): void {
  const state = getProgramAudioBusState(programId, true);
  if (!state) {
    return;
  }

  const normalizedVolume = clampVolume(volume);
  state.masterVolume = normalizedVolume;

  if (state.activeAudio) {
    state.activeAudio.volume = normalizedVolume;
  }

  emit(state);
}

export function getProgramAudioBusSnapshot(programId: string): ProgramAudioBusSnapshot {
  const state = getProgramAudioBusState(programId, false);
  if (!state) {
    return {
      track: null,
      progress: 0,
      endedToken: '',
      isPlaying: false
    };
  }

  return getSnapshot(state);
}

export function getProgramAudioBusSignalLevel(programId: string): number {
  const state = getProgramAudioBusState(programId, false);
  if (!state || !state.activeAudio || state.activeAudio.paused || state.activeAudio.ended) {
    return 0;
  }
  if (!state.meterAnalyser || !state.meterBuffer) {
    return 0;
  }

  state.meterAnalyser.getFloatTimeDomainData(state.meterBuffer);
  let sumSquares = 0;
  for (let index = 0; index < state.meterBuffer.length; index += 1) {
    const sample = state.meterBuffer[index];
    sumSquares += sample * sample;
  }

  const rms = Math.sqrt(sumSquares / state.meterBuffer.length);
  const smoothed = state.lastSignalLevel * 0.72 + rms * 0.28;
  state.lastSignalLevel = smoothed;
  return Math.max(0, Math.min(1, smoothed));
}

export function subscribeProgramAudioBus(programId: string, listener: Listener): () => void {
  const state = getProgramAudioBusState(programId, true);
  if (!state) {
    listener({
      track: null,
      progress: 0,
      endedToken: '',
      isPlaying: false
    });
    return () => {
      // no-op
    };
  }

  state.listeners.add(listener);
  listener(getSnapshot(state));
  return () => {
    state.listeners.delete(listener);
  };
}
