import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModoItalianoPodcastPlayer } from './ModoItalianoPodcastPlayer';

// gaulatti/alcantara#184: the original Modo Italiano podcast player, through
// its props, the audio element and what it draws.

/** A 2D context that records what each canvas draws. */
function recordingContext() {
  const calls: string[] = [];
  const context = {
    clearRect: () => calls.push('clear'),
    fillRect: () => calls.push('fill'),
    beginPath: () => calls.push('path'),
    moveTo: () => calls.push('move'),
    lineTo: () => calls.push('line'),
    stroke: () => calls.push('stroke'),
    createRadialGradient: () => ({ addColorStop: () => calls.push('stop') }),
    fillStyle: '' as unknown,
    strokeStyle: '',
    lineWidth: 0,
    globalCompositeOperation: '',
  };
  return { context, calls };
}

let frames: FrameRequestCallback[];
let cancelled: number[];
let contexts: Map<HTMLCanvasElement, ReturnType<typeof recordingContext>>;
let audioContexts: Array<{ state: string; resume: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>;
let spectrum: Uint8Array;

class FakeAudioContext {
  state = 'suspended';
  destination = {};
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  constructor() {
    audioContexts.push(this);
  }
  createAnalyser() {
    return {
      connect: vi.fn(),
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 10,
      getByteFrequencyData: (target: Uint8Array) => target.set(spectrum),
    };
  }
  createMediaElementSource() {
    return { connect: vi.fn() };
  }
}

beforeEach(() => {
  frames = [];
  cancelled = [];
  contexts = new Map();
  audioContexts = [];
  spectrum = new Uint8Array([255, 0, 128, 255, 255, 0, 0, 0, 0, 0]);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => cancelled.push(id));
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    if (!contexts.has(this)) contexts.set(this, recordingContext());
    return contexts.get(this)!.context as never;
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Runs every queued animation frame once. */
const runFrames = () => {
  const queued = frames.splice(0);
  queued.forEach((frame) => frame(1000));
};

const canvases = (container: HTMLElement) => {
  const [background, visualizer] = Array.from(container.querySelectorAll('canvas'));
  return { background, visualizer };
};

it('shows the episode, its cover and placeholders for missing copy', () => {
  const { rerender } = render(<ModoItalianoPodcastPlayer />);
  expect(screen.getByText('Episode Title')).toBeInTheDocument();
  expect(screen.getByText('Show Name')).toBeInTheDocument();
  expect(screen.queryByRole('img', { name: 'Episode cover' })).toBeNull();
  rerender(<ModoItalianoPodcastPlayer coverUrl='/cover.jpg' episodeTitle='Puntata uno' showName='Modo Italiano' />);
  expect(screen.getByRole('img', { name: 'Episode cover' })).toHaveAttribute('src', '/cover.jpg');
  expect(screen.getByText('Puntata uno')).toBeInTheDocument();
  expect(screen.getByText('Modo Italiano')).toBeInTheDocument();
});

it('renders nothing and starts nothing while hidden', () => {
  const { container } = render(<ModoItalianoPodcastPlayer show={false} audioUrl='/episode.mp3' />);
  expect(container).toBeEmptyDOMElement();
  expect(frames).toHaveLength(0);
  expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
});

it('loads the episode, starts it when ready through an analyser, and follows its clock', () => {
  const { container } = render(<ModoItalianoPodcastPlayer audioUrl='/episode.mp3' masterGain={1.7} />);
  const audio = container.querySelector('audio')!;
  expect(audio.getAttribute('src')).toBe('/episode.mp3');
  expect(audio.load).toHaveBeenCalled();
  expect(audio.volume).toBe(1);
  expect(audio.muted).toBe(false);

  fireEvent.canPlay(audio);
  expect(audioContexts).toHaveLength(1);
  expect(audioContexts[0].resume).toHaveBeenCalled();
  expect(audio.play).toHaveBeenCalledTimes(1);

  Object.defineProperty(audio, 'duration', { configurable: true, value: 125 });
  fireEvent.loadedMetadata(audio);
  Object.defineProperty(audio, 'currentTime', { configurable: true, writable: true, value: 65 });
  fireEvent.timeUpdate(audio);
  expect(screen.getByText('1:05')).toBeInTheDocument();
  expect(screen.getByText('2:05')).toBeInTheDocument();
});

it('waits for interaction when autoplay is refused, until playback starts', async () => {
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error('NotAllowedError'));
  const { container } = render(<ModoItalianoPodcastPlayer audioUrl='/episode.mp3' />);
  const audio = container.querySelector('audio')!;
  await act(async () => {
    fireEvent.canPlay(audio);
  });
  expect(screen.getByText('Waiting for interaction to start playback')).toBeInTheDocument();
  fireEvent.play(audio);
  expect(screen.queryByText('Waiting for interaction to start playback')).toBeNull();
});

it('mutes at zero gain and loads nothing without an episode', () => {
  const { container, rerender } = render(<ModoItalianoPodcastPlayer audioUrl='' masterGain={0} />);
  const audio = container.querySelector('audio')!;
  expect(audio.muted).toBe(true);
  expect(audio.volume).toBe(0);
  expect(audio.load).not.toHaveBeenCalled();
  rerender(<ModoItalianoPodcastPlayer audioUrl='' masterGain={-1} />);
  expect(audio.volume).toBe(0);
});

it('shows 0:00 for an unknown duration', () => {
  const { container } = render(<ModoItalianoPodcastPlayer audioUrl='/live.mp3' />);
  const audio = container.querySelector('audio')!;
  Object.defineProperty(audio, 'duration', { configurable: true, value: Number.NaN });
  fireEvent.durationChange(audio);
  expect(screen.getAllByText('0:00')).toHaveLength(2);
});

it('seeks from a click on the progress bar once the duration is known', () => {
  const { container } = render(<ModoItalianoPodcastPlayer audioUrl='/episode.mp3' />);
  const audio = container.querySelector('audio')!;
  Object.defineProperty(audio, 'currentTime', { configurable: true, writable: true, value: 0 });
  const bar = container.querySelector('div[style*="cursor: pointer"]') as HTMLElement;
  vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue({ left: 100, width: 400 } as DOMRect);
  fireEvent.click(bar, { clientX: 300 });
  expect(audio.currentTime).toBe(0);
  Object.defineProperty(audio, 'duration', { configurable: true, value: 200 });
  fireEvent.durationChange(audio);
  fireEvent.click(bar, { clientX: 300 });
  expect(audio.currentTime).toBe(100);
  fireEvent.click(bar, { clientX: 900 });
  expect(audio.currentTime).toBe(200);
  fireEvent.click(bar, { clientX: 0 });
  expect(audio.currentTime).toBe(0);
});

it('animates the background and an idle wave, then the spectrum while playing', () => {
  const { container } = render(<ModoItalianoPodcastPlayer audioUrl='/episode.mp3' />);
  const { background, visualizer } = canvases(container);
  runFrames();
  expect(contexts.get(background)!.calls.filter((call) => call === 'stop')).toHaveLength(14);
  const idle = contexts.get(visualizer)!.calls;
  expect(idle.filter((call) => call === 'stroke')).toHaveLength(2);
  expect(idle).toContain('move');
  expect(idle).toContain('line');

  const audio = container.querySelector('audio')!;
  fireEvent.canPlay(audio);
  fireEvent.play(audio);
  idle.length = 0;
  runFrames();
  // 6 usable bins: 255, 0, 128, 255, 255, 0. Each loud bin draws a mirrored
  // pair; the silent ones are skipped. Then the centre line.
  expect(contexts.get(visualizer)!.calls).toEqual([
    'clear',
    'fill', 'fill',
    'fill', 'fill',
    'fill', 'fill',
    'fill', 'fill',
    'fill',
  ]);

  fireEvent.pause(audio);
  contexts.get(visualizer)!.calls.length = 0;
  runFrames();
  expect(contexts.get(visualizer)!.calls.filter((call) => call === 'stroke')).toHaveLength(2);
  fireEvent.play(audio);
  fireEvent.ended(audio);
  contexts.get(visualizer)!.calls.length = 0;
  runFrames();
  expect(contexts.get(visualizer)!.calls.filter((call) => call === 'stroke')).toHaveLength(2);
});

it('stops animating a canvas the browser cannot draw on', () => {
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
  render(<ModoItalianoPodcastPlayer />);
  runFrames();
  expect(frames).toHaveLength(0);
});

it('plays without a visualiser where Web Audio is unavailable, and reuses one analyser', () => {
  vi.stubGlobal('AudioContext', class {
    constructor() {
      throw new Error('restricted');
    }
  });
  const { container, rerender } = render(<ModoItalianoPodcastPlayer audioUrl='/one.mp3' />);
  const audio = container.querySelector('audio')!;
  fireEvent.canPlay(audio);
  expect(audio.play).toHaveBeenCalledTimes(1);

  vi.stubGlobal('AudioContext', FakeAudioContext);
  rerender(<ModoItalianoPodcastPlayer audioUrl='/two.mp3' />);
  fireEvent.canPlay(audio);
  rerender(<ModoItalianoPodcastPlayer audioUrl='/three.mp3' />);
  const running = audioContexts[0];
  running.state = 'running';
  fireEvent.canPlay(audio);
  expect(audioContexts).toHaveLength(1);
  expect(running.resume).toHaveBeenCalledTimes(1);
  expect(audio.play).toHaveBeenCalledTimes(3);
});

it('stops its animations and closes its audio graph when it closes', () => {
  const { container, unmount } = render(<ModoItalianoPodcastPlayer audioUrl='/episode.mp3' />);
  fireEvent.canPlay(container.querySelector('audio')!);
  unmount();
  expect(cancelled.length).toBeGreaterThanOrEqual(2);
  expect(audioContexts[0].close).toHaveBeenCalled();
});

it('closes cleanly when it never started audio', () => {
  render(<ModoItalianoPodcastPlayer />).unmount();
  expect(audioContexts).toHaveLength(0);
});
