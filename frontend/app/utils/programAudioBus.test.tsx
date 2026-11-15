import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureProgramAudioBusTrack, getProgramAudioBusSnapshot, stopProgramAudioBus } from './programAudioBus';

/** Just enough of an audio element for the bus: it "plays" as soon as play() is called. */
class FakeAudio {
  static created: FakeAudio[] = [];
  src: string;
  volume = 1;
  paused = true;
  ended = false;
  currentTime = 0;
  duration = 180;
  crossOrigin: string | null = null;
  preload = '';
  onplaying: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onended: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(src = '') {
    this.src = src;
    FakeAudio.created.push(this);
  }
  play() {
    this.paused = false;
    this.onplaying?.();
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.onpause?.();
  }
  addEventListener() {}
  removeEventListener() {}
}

const track = (name: string) => ({ token: `manual:${name}`, audioUrl: `https://audio.test/${name}.mp3`, artist: name, title: name });
const playing = () => FakeAudio.created.filter((audio) => !audio.paused).map((audio) => audio.src.split('/').pop());

describe('program audio bus: switching songs', () => {
  let programId = '';

  beforeEach(() => {
    vi.useFakeTimers();
    FakeAudio.created = [];
    vi.stubGlobal('Audio', FakeAudio);
    programId = `bus-test-${Math.random()}`;
  });

  afterEach(() => {
    stopProgramAudioBus(programId);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('starts a song at once when nothing is playing', () => {
    ensureProgramAudioBusTrack(programId, track('one'));
    expect(playing()).toEqual(['one.mp3']);
    expect(getProgramAudioBusSnapshot(programId).track?.token).toBe('manual:one');
  });

  it('switches to a second song while the first plays, even when asked again during the fade', async () => {
    ensureProgramAudioBusTrack(programId, track('one'));

    // The program page asks for the selected song on every state update. Ask every 100ms, which is
    // faster than the 420ms fade-out; this used to restart the fade each time and never switch.
    for (let elapsed = 0; elapsed < 1500; elapsed += 100) {
      ensureProgramAudioBusTrack(programId, track('two'));
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(getProgramAudioBusSnapshot(programId).track?.token).toBe('manual:two');
    expect(playing()).toEqual(['two.mp3']);
    // One element per song: the repeated requests did not start the second song more than once.
    expect(FakeAudio.created.map((audio) => audio.src.split('/').pop())).toEqual(['one.mp3', 'two.mp3']);
  });

  it('follows a change of mind during the fade to the song asked for last', async () => {
    ensureProgramAudioBusTrack(programId, track('one'));
    ensureProgramAudioBusTrack(programId, track('two'));
    await vi.advanceTimersByTimeAsync(100);
    ensureProgramAudioBusTrack(programId, track('three'));
    await vi.advanceTimersByTimeAsync(1500);

    expect(getProgramAudioBusSnapshot(programId).track?.token).toBe('manual:three');
    expect(playing()).toEqual(['three.mp3']);
  });

  it('lets a stop during the fade win, and plays a song asked for afterwards', async () => {
    ensureProgramAudioBusTrack(programId, track('one'));
    ensureProgramAudioBusTrack(programId, track('two'));
    await vi.advanceTimersByTimeAsync(100);
    stopProgramAudioBus(programId);
    await vi.advanceTimersByTimeAsync(1000);
    expect(playing()).toEqual([]);
    expect(getProgramAudioBusSnapshot(programId).track).toBeNull();

    ensureProgramAudioBusTrack(programId, track('two'));
    expect(playing()).toEqual(['two.mp3']);
  });
});
