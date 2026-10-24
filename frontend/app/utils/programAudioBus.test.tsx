import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureProgramAudioBusTrack, getProgramAudioBusSignalLevel, getProgramAudioBusSignalSnapshot,
  getProgramAudioBusSnapshot, setProgramAudioBusMasterVolume, stopProgramAudioBus, subscribeProgramAudioBus,
} from './programAudioBus';

class BrowserAudio {
  static instances: BrowserAudio[] = [];
  static rejectPlay = false;
  volume = 1;
  duration = 10;
  currentTime = 0;
  paused = true;
  ended = false;
  muted = false;
  preload = '';
  onplay: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly src: string) { BrowserAudio.instances.push(this); }
  play = vi.fn(() => {
    if (BrowserAudio.rejectPlay) return Promise.reject(new Error('Autoplay denied'));
    this.paused = false;
    this.onplay?.();
    return Promise.resolve();
  });
  pause = vi.fn(() => { this.paused = true; this.onpause?.(); });
}

class BrowserAudioContext {
  static instances: BrowserAudioContext[] = [];
  state = 'running';
  destination = {};
  source = { connect: vi.fn(), disconnect: vi.fn() };
  analyser = { fftSize: 1024, smoothingTimeConstant: 0, disconnect: vi.fn(), getFloatTimeDomainData: vi.fn((values: Float32Array) => values.fill(0.5)) };
  createMediaElementSource = vi.fn(() => this.source);
  createMediaStreamSource = vi.fn(() => this.source);
  createAnalyser = vi.fn(() => this.analyser);
  resume = vi.fn(async () => { this.state = 'running'; });
  decodeAudioData = vi.fn();
  constructor() { BrowserAudioContext.instances.push(this); }
}

let id = 0;
let programs: string[];
const program = () => { const value = `audio-behavior-${++id}`; programs.push(value); return value; };
const track = (token = 'first') => ({ token, audioUrl: `https://media.example/${token}.mp3`, title: token, durationMs: 10000 });

beforeEach(() => {
  programs = [];
  BrowserAudio.instances = [];
  BrowserAudio.rejectPlay = false;
  BrowserAudioContext.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal('Audio', BrowserAudio);
  vi.stubGlobal('AudioContext', undefined);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
});
afterEach(async () => {
  programs.forEach(stopProgramAudioBus);
  await vi.advanceTimersByTimeAsync(1000);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('Program audio bus playback lifecycle', () => {
  it('keeps blank and stopped programs silent without creating an audio element', () => {
    ensureProgramAudioBusTrack('', track());
    ensureProgramAudioBusTrack(program(), { token: '', audioUrl: '' });
    expect(BrowserAudio.instances).toHaveLength(0);
    expect(getProgramAudioBusSnapshot('')).toEqual({ track: null, progress: 0, currentTimeMs: 0, durationMs: null, endedToken: '', isPlaying: false });
    expect(getProgramAudioBusSignalSnapshot('')).toEqual({ rms: 0, peak: 0 });
    expect(getProgramAudioBusSignalLevel('')).toBe(0);
    const listener = vi.fn();
    subscribeProgramAudioBus('', listener)();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ track: null, isPlaying: false }));
  });

  it('publishes real playback, progress, metadata, pause, error and ended state to subscribers', () => {
    const p = program();
    const listener = vi.fn();
    const unsubscribe = subscribeProgramAudioBus(p, listener);
    ensureProgramAudioBusTrack(p, track());
    const audio = BrowserAudio.instances[0];
    expect(audio.src).toBe('https://media.example/first.mp3');
    expect(getProgramAudioBusSnapshot(p)).toMatchObject({ isPlaying: true, track: { token: 'first' } });
    audio.currentTime = 4;
    audio.ontimeupdate?.();
    expect(getProgramAudioBusSnapshot(p)).toMatchObject({ progress: 0.4, currentTimeMs: 4000, durationMs: 10000 });
    audio.duration = 20;
    audio.onloadedmetadata?.();
    expect(getProgramAudioBusSnapshot(p)).toMatchObject({ progress: 0.2, durationMs: 20000 });
    audio.pause();
    expect(getProgramAudioBusSnapshot(p).isPlaying).toBe(false);
    audio.play();
    audio.onerror?.();
    expect(getProgramAudioBusSnapshot(p).isPlaying).toBe(false);
    audio.ended = true;
    audio.onended?.();
    expect(getProgramAudioBusSnapshot(p)).toMatchObject({ endedToken: 'first', progress: 1, isPlaying: false });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ endedToken: 'first' }));
    unsubscribe();
    const calls = listener.mock.calls.length;
    stopProgramAudioBus(p);
    expect(listener).toHaveBeenCalledTimes(calls);
    expect(audio.pause).toHaveBeenCalled();
    expect(getProgramAudioBusSnapshot(p)).toMatchObject({ track: null, currentTimeMs: 0, durationMs: null });
  });

  it('reuses matching tracks and resumes an ended or paused item without allocating a second player', () => {
    const p = program();
    ensureProgramAudioBusTrack(p, track());
    const audio = BrowserAudio.instances[0];
    audio.currentTime = 10;
    audio.ended = true;
    audio.paused = true;
    audio.onended?.();
    ensureProgramAudioBusTrack(p, track());
    expect(BrowserAudio.instances).toHaveLength(1);
    expect(audio.currentTime).toBe(0);
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(getProgramAudioBusSnapshot(p)).toMatchObject({ progress: 0, endedToken: '' });
  });

  it('reports unsupported media duration safely and clamps source time within a known duration', () => {
    const p = program();
    ensureProgramAudioBusTrack(p, track());
    const audio = BrowserAudio.instances[0];
    audio.duration = NaN;
    audio.currentTime = 50;
    audio.ontimeupdate?.();
    expect(getProgramAudioBusSnapshot(p)).toMatchObject({ progress: 0, currentTimeMs: 10000, durationMs: 10000 });
    audio.currentTime = -1;
    expect(getProgramAudioBusSnapshot(p).currentTimeMs).toBe(0);
  });

  it('contains autoplay rejection and leaves the track visibly not playing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    BrowserAudio.rejectPlay = true;
    const p = program();
    ensureProgramAudioBusTrack(p, track());
    await Promise.resolve();
    expect(getProgramAudioBusSnapshot(p)).toMatchObject({ track: { token: 'first' }, isPlaying: false });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to start audio bus track'), expect.any(Error));
    ensureProgramAudioBusTrack(p, track());
    await Promise.resolve();
    expect(BrowserAudio.instances).toHaveLength(1);
  });

  it('fades out the old track before the replacement plays and fades in to the saved output gain', async () => {
    const p = program();
    setProgramAudioBusMasterVolume(p, 0.4);
    ensureProgramAudioBusTrack(p, track());
    const outgoing = BrowserAudio.instances[0];
    expect(outgoing.volume).toBe(0.4);
    ensureProgramAudioBusTrack(p, track('next'));
    await vi.advanceTimersByTimeAsync(200);
    expect(outgoing.volume).toBeLessThan(0.4);
    expect(BrowserAudio.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(outgoing.pause).toHaveBeenCalled();
    expect(BrowserAudio.instances).toHaveLength(2);
    expect(BrowserAudio.instances[1].volume).toBe(0.4);
    expect(getProgramAudioBusSnapshot(p)).toMatchObject({ track: { token: 'next' }, isPlaying: true });
  });

  it('cancels a pending transition when the operator explicitly stops Program audio', async () => {
    const p = program();
    ensureProgramAudioBusTrack(p, track());
    ensureProgramAudioBusTrack(p, track('cancelled'));
    await vi.advanceTimersByTimeAsync(100);
    stopProgramAudioBus(p);
    await vi.advanceTimersByTimeAsync(1000);
    expect(BrowserAudio.instances).toHaveLength(1);
    expect(getProgramAudioBusSnapshot(p)).toMatchObject({ track: null, isPlaying: false });
  });
});

describe('Program audio bus signal and output gain', () => {
  it('normalizes output volume and exposes a bounded post-fader fallback with attack and release', () => {
    const p = program();
    setProgramAudioBusMasterVolume(p, 0.5);
    ensureProgramAudioBusTrack(p, track());
    expect(getProgramAudioBusSignalSnapshot(p)).toEqual({ rms: 0.5, peak: 0.5 });
    const attack = getProgramAudioBusSignalLevel(p);
    expect(attack).toBeGreaterThan(0);
    expect(attack).toBeLessThan(0.5);
    setProgramAudioBusMasterVolume(p, -1);
    expect(BrowserAudio.instances[0].volume).toBe(0);
    expect(getProgramAudioBusSignalLevel(p)).toBeLessThan(attack);
    setProgramAudioBusMasterVolume(p, 9);
    expect(BrowserAudio.instances[0].volume).toBe(1);
    setProgramAudioBusMasterVolume(p, NaN);
    expect(BrowserAudio.instances[0].volume).toBe(1);
    BrowserAudio.instances[0].paused = true;
    expect(getProgramAudioBusSignalSnapshot(p)).toEqual({ rms: 0, peak: 0 });
  });

  it('reads the real analyser buffer and releases media-element audio routing when stopped', async () => {
    vi.stubGlobal('AudioContext', BrowserAudioContext);
    const p = program();
    ensureProgramAudioBusTrack(p, track('analysed'));
    const audio = BrowserAudio.instances[0];
    const context = BrowserAudioContext.instances[0];
    expect(audio.muted).toBe(true);
    expect(context.source.connect).toHaveBeenCalledWith(context.destination);
    expect(getProgramAudioBusSignalSnapshot(p)).toEqual({ rms: 0.5, peak: 0.5 });
    expect(context.analyser.getFloatTimeDomainData).toHaveBeenCalledWith(expect.any(Float32Array));
    stopProgramAudioBus(p);
    expect(audio.muted).toBe(false);
    expect(context.source.disconnect).toHaveBeenCalled();
    expect(context.analyser.disconnect).toHaveBeenCalled();
    await Promise.resolve();
  });
});
