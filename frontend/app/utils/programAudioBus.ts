import { interpolateGainLog } from './audioTaper';
import { apiUrl } from './apiBaseUrl';

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
  currentTimeMs: number;
  durationMs: number | null;
  endedToken: string;
  isPlaying: boolean;
}

export interface ProgramAudioBusSignalSnapshot {
  rms: number;
  peak: number;
}

type Listener = (snapshot: ProgramAudioBusSnapshot) => void;

interface MeterEnvelope {
  stepMs: number;
  values: Float32Array;
}

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
  meterEnvelopeUrl: string;
  meterEnvelope: MeterEnvelope | null;
}

const audioBusByProgram = new Map<string, ProgramAudioBusState>();
const meterEnvelopeByUrl = new Map<string, Promise<MeterEnvelope | null>>();
const AUDIO_FADE_OUT_MS = 420;
const AUDIO_FADE_IN_MS = 320;
const AUDIO_FADE_STEP_MS = 20;
const AUDIO_TARGET_VOLUME = 1;
const METER_ENVELOPE_FRAME_MS = 24;
const METER_ENVELOPE_LOW_PERCENTILE = 0.12;
const METER_ENVELOPE_HIGH_PERCENTILE = 0.985;
const METER_ENVELOPE_TOP_EXPAND_POWER = 1.6;
const METER_ATTACK_COEFFICIENT = 0.45;
const METER_RELEASE_COEFFICIENT = 0.2;

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
    meterUsesMediaElementFallback: false,
    meterEnvelopeUrl: '',
    meterEnvelope: null
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
  const hasTrack = Boolean(state.activeTrack);
  const durationSeconds = state.activeAudio ? Number(state.activeAudio.duration) : Number.NaN;
  const derivedDurationMs = Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.round(durationSeconds * 1000) : null;
  const durationMs =
    derivedDurationMs ??
    (typeof state.activeTrack?.durationMs === 'number' && Number.isFinite(state.activeTrack.durationMs) && state.activeTrack.durationMs > 0
      ? Math.round(state.activeTrack.durationMs)
      : null);
  const currentSeconds = state.activeAudio ? Number(state.activeAudio.currentTime) : Number.NaN;
  let currentTimeMs = Number.isFinite(currentSeconds) && currentSeconds >= 0 ? Math.round(currentSeconds * 1000) : 0;
  if (durationMs !== null) {
    currentTimeMs = Math.max(0, Math.min(currentTimeMs, durationMs));
  }

  return {
    track: state.activeTrack,
    progress: state.progress,
    currentTimeMs: hasTrack ? currentTimeMs : 0,
    durationMs: hasTrack ? durationMs : null,
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

function getAudioContextConstructor():
  | typeof AudioContext
  | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  return (
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext
  );
}

function buildMeterEnvelope(audioBuffer: AudioBuffer): MeterEnvelope | null {
  const { numberOfChannels, length, sampleRate } = audioBuffer;
  if (numberOfChannels <= 0 || length <= 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return null;
  }

  const frameSize = Math.max(256, Math.round((sampleRate * METER_ENVELOPE_FRAME_MS) / 1000));
  const frameCount = Math.max(1, Math.ceil(length / frameSize));
  const values = new Float32Array(frameCount);

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const start = frameIndex * frameSize;
    const end = Math.min(length, start + frameSize);
    const sampleCount = Math.max(1, end - start);
    let peakChannelRms = 0;

    for (let channelIndex = 0; channelIndex < numberOfChannels; channelIndex += 1) {
      const channelData = audioBuffer.getChannelData(channelIndex);
      let sumSquares = 0;
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        const sample = channelData[sampleIndex];
        sumSquares += sample * sample;
      }
      const rms = Math.sqrt(sumSquares / sampleCount);
      if (rms > peakChannelRms) {
        peakChannelRms = rms;
      }
    }

    values[frameIndex] = peakChannelRms;
  }

  if (values.length === 0) {
    return {
      stepMs: frameSize * 1000 / sampleRate,
      values
    };
  }

  const sortedValues = Array.from(values).sort((left, right) => left - right);
  const lowIndex = Math.max(0, Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * METER_ENVELOPE_LOW_PERCENTILE)));
  const highIndex = Math.max(lowIndex, Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * METER_ENVELOPE_HIGH_PERCENTILE)));
  const floorValue = sortedValues[lowIndex] ?? 0;
  const ceilingValue = Math.max(floorValue + 1e-6, sortedValues[highIndex] ?? floorValue + 1e-6);
  let previousNormalized = 0;

  // Normalize using percentiles and add transient emphasis for visible movement.
  for (let index = 0; index < values.length; index += 1) {
    const normalized = Math.max(0, Math.min(1, (values[index] - floorValue) / (ceilingValue - floorValue)));
    const topExpanded = Math.pow(normalized, METER_ENVELOPE_TOP_EXPAND_POWER);
    const transient = Math.max(0, topExpanded - previousNormalized * 0.94);
    const emphasized = Math.max(0, Math.min(1, topExpanded * 0.8 + transient * 1.25));
    values[index] = emphasized;
    previousNormalized = emphasized;
  }

  return {
    stepMs: frameSize * 1000 / sampleRate,
    values
  };
}

function getMeterEnvelope(audioUrl: string, context: AudioContext): Promise<MeterEnvelope | null> {
  const existing = meterEnvelopeByUrl.get(audioUrl);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    try {
      const response = await fetch(resolveEnvelopeFetchUrl(audioUrl));
      if (!response.ok) {
        return null;
      }
      const arrayBuffer = await response.arrayBuffer();
      const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
      return buildMeterEnvelope(decoded);
    } catch {
      return null;
    }
  })();

  meterEnvelopeByUrl.set(audioUrl, promise);
  return promise;
}

function resolveEnvelopeFetchUrl(audioUrl: string): string {
  const normalized = audioUrl.trim();
  if (!normalized) {
    return normalized;
  }

  try {
    const parsed = new URL(normalized, window.location.href);
    if (parsed.origin === window.location.origin) {
      return parsed.toString();
    }
    return apiUrl(`/program/audio-proxy?url=${encodeURIComponent(parsed.toString())}`);
  } catch {
    return apiUrl(`/program/audio-proxy?url=${encodeURIComponent(normalized)}`);
  }
}

function setupAudioMeterEnvelope(state: ProgramAudioBusState, trackAudioUrl: string): void {
  const normalizedUrl = typeof trackAudioUrl === 'string' ? trackAudioUrl.trim() : '';
  state.meterEnvelopeUrl = normalizedUrl;
  state.meterEnvelope = null;
  if (!normalizedUrl) {
    return;
  }

  const AudioContextCtor = getAudioContextConstructor();
  if (!AudioContextCtor) {
    return;
  }
  const context = state.meterContext ?? new AudioContextCtor();
  state.meterContext = context;

  void getMeterEnvelope(normalizedUrl, context).then((envelope) => {
    if (state.meterEnvelopeUrl !== normalizedUrl) {
      return;
    }
    state.meterEnvelope = envelope;
  });
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

function setActiveAudio(state: ProgramAudioBusState, audio: HTMLAudioElement, trackToken: string, trackAudioUrl: string): void {
  audio.preload = 'auto';
  setupAudioMeter(state, audio);
  setupAudioMeterEnvelope(state, trackAudioUrl);

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
  setActiveAudio(state, audio, track.token, track.audioUrl);
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
  setActiveAudio(state, incomingAudio, track.token, track.audioUrl);
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
  state.meterEnvelopeUrl = '';
  state.meterEnvelope = null;
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
      currentTimeMs: 0,
      durationMs: null,
      endedToken: '',
      isPlaying: false
    };
  }

  return getSnapshot(state);
}

export function getProgramAudioBusSignalLevel(programId: string): number {
  const snapshot = getProgramAudioBusSignalSnapshot(programId);
  const state = getProgramAudioBusState(programId, false);
  if (!state) {
    return 0;
  }

  const coefficient = snapshot.rms >= state.lastSignalLevel ? METER_ATTACK_COEFFICIENT : METER_RELEASE_COEFFICIENT;
  const smoothed = state.lastSignalLevel + (snapshot.rms - state.lastSignalLevel) * coefficient;
  state.lastSignalLevel = smoothed;
  return Math.max(0, Math.min(1, smoothed));
}

export function getProgramAudioBusSignalSnapshot(programId: string): ProgramAudioBusSignalSnapshot {
  const state = getProgramAudioBusState(programId, false);
  if (!state || !state.activeAudio || state.activeAudio.paused || state.activeAudio.ended) {
    if (state) {
      state.lastSignalLevel = 0;
    }
    return {
      rms: 0,
      peak: 0
    };
  }
  let nextRms = 0;
  let nextPeak = 0;
  if (state.meterAnalyser && state.meterBuffer) {
    state.meterAnalyser.getFloatTimeDomainData(state.meterBuffer);
    let sumSquares = 0;
    let peakSample = 0;
    for (let index = 0; index < state.meterBuffer.length; index += 1) {
      const sample = state.meterBuffer[index];
      sumSquares += sample * sample;
      const absSample = Math.abs(sample);
      if (absSample > peakSample) {
        peakSample = absSample;
      }
    }
    nextRms = Math.sqrt(sumSquares / state.meterBuffer.length);
    nextPeak = peakSample;
  } else if (
    state.meterEnvelope &&
    state.meterEnvelope.values.length > 0 &&
    Number.isFinite(state.activeAudio.currentTime)
  ) {
    const timeMs = Math.max(0, state.activeAudio.currentTime * 1000);
    const envelopeIndex = Math.max(
      0,
      Math.min(
        state.meterEnvelope.values.length - 1,
      Math.floor(timeMs / Math.max(1, state.meterEnvelope.stepMs))
      )
    );
    const envelopeLevel = state.meterEnvelope.values[envelopeIndex] ?? 0;
    const normalizedEnvelopeLevel = envelopeLevel * clampVolume(state.activeAudio.volume);
    nextRms = normalizedEnvelopeLevel;
    nextPeak = normalizedEnvelopeLevel;
  } else {
    // Fallback when analyser capture is unavailable (e.g. restricted embeds):
    // report post-fader output level so control still reflects live gain changes.
    const volume = clampVolume(state.activeAudio.volume);
    nextRms = volume;
    nextPeak = volume;
  }

  return {
    rms: Math.max(0, Math.min(1, nextRms)),
    peak: Math.max(0, Math.min(1, nextPeak))
  };
}

export function subscribeProgramAudioBus(programId: string, listener: Listener): () => void {
  const state = getProgramAudioBusState(programId, true);
  if (!state) {
    listener({
      track: null,
      progress: 0,
      currentTimeMs: 0,
      durationMs: null,
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
