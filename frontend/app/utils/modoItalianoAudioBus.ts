export interface ModoItalianoAudioBusTrack {
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

export interface ModoItalianoAudioBusSnapshot {
  track: ModoItalianoAudioBusTrack | null;
  progress: number;
  endedToken: string;
  isPlaying: boolean;
}

type Listener = (snapshot: ModoItalianoAudioBusSnapshot) => void;

interface ProgramAudioBusState {
  activeTrack: ModoItalianoAudioBusTrack | null;
  activeAudio: HTMLAudioElement | null;
  progress: number;
  endedToken: string;
  isPlaying: boolean;
  transitionVersion: number;
  listeners: Set<Listener>;
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
    progress: 0,
    endedToken: '',
    isPlaying: false,
    transitionVersion: 0,
    listeners: new Set<Listener>()
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

function getSnapshot(state: ProgramAudioBusState): ModoItalianoAudioBusSnapshot {
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
  const delta = normalizedTo - normalizedFrom;

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
      audio.volume = clampVolume(normalizedFrom + delta * ratio);

      if (ratio >= 1) {
        window.clearInterval(timer);
        resolve();
      }
    }, AUDIO_FADE_STEP_MS);
  });
}

function setActiveAudio(state: ProgramAudioBusState, audio: HTMLAudioElement, trackToken: string): void {
  audio.preload = 'auto';

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

function replaceTrack(state: ProgramAudioBusState, track: ModoItalianoAudioBusTrack): void {
  if (state.activeAudio) {
    detachAndStopAudio(state.activeAudio);
    state.activeAudio = null;
  }

  state.activeTrack = track;
  state.progress = 0;
  state.endedToken = '';
  state.isPlaying = false;

  const audio = new Audio(track.audioUrl);
  audio.volume = AUDIO_TARGET_VOLUME;
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

async function transitionToTrackWithFade(state: ProgramAudioBusState, track: ModoItalianoAudioBusTrack): Promise<void> {
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

  await fadeAudioVolume(incomingAudio, incomingAudio.volume, AUDIO_TARGET_VOLUME, AUDIO_FADE_IN_MS, () => version === state.transitionVersion);

  if (version !== state.transitionVersion) {
    return;
  }
  incomingAudio.volume = AUDIO_TARGET_VOLUME;
}

export function ensureModoItalianoAudioBusTrack(programId: string, track: ModoItalianoAudioBusTrack): void {
  const state = getProgramAudioBusState(programId, true);
  if (!state) {
    return;
  }

  const normalizedToken = track.token.trim();
  const normalizedUrl = track.audioUrl.trim();
  if (!normalizedToken || !normalizedUrl) {
    return;
  }

  const normalizedTrack: ModoItalianoAudioBusTrack = {
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

export function stopModoItalianoAudioBus(programId: string): void {
  const state = getProgramAudioBusState(programId, false);
  if (!state) {
    return;
  }

  state.transitionVersion += 1;

  if (state.activeAudio) {
    detachAndStopAudio(state.activeAudio);
    state.activeAudio = null;
  }

  state.activeTrack = null;
  state.progress = 0;
  state.endedToken = '';
  state.isPlaying = false;
  emit(state);
}

export function getModoItalianoAudioBusSnapshot(programId: string): ModoItalianoAudioBusSnapshot {
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

export function subscribeModoItalianoAudioBus(programId: string, listener: Listener): () => void {
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
