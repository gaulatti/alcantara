import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModoItalianoGiorgiaPodcastPlayer } from './ModoItalianoGiorgiaPodcastPlayer';
import { getComponentMetadata } from '../models/components';

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.stubGlobal('AudioContext', class {
    destination = {};
    createAnalyser() { return { connect: vi.fn(), fftSize: 256, smoothingTimeConstant: 0.85 }; }
    createMediaElementSource() { return { connect: vi.fn() }; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('registers an independent template without replacing the legacy player', () => {
  expect(getComponentMetadata('modoitaliano-podcast-player')?.name).toBe('Modo Italiano Podcast Player');
  expect(getComponentMetadata('modoitaliano-giorgia-podcast-player')?.defaultProps).toEqual({
    show: true, coverUrl: '', episodeTitle: '', showName: '', audioUrl: '',
  });
});

it('renders full long copy, centered cover and exactly one ModoItaliano logo', () => {
  const title = 'Una lunghissima conversazione sulla musica italiana e le canzoni che ci accompagnano ogni giorno';
  render(<ModoItalianoGiorgiaPodcastPlayer episodeTitle={title} showName='Modo Italiano' coverUrl='/cover.jpg' />);
  expect(screen.getByRole('heading')).toHaveTextContent(title);
  expect(screen.getByRole('heading')).toHaveStyle({ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' });
  expect(screen.getByRole('img', { name: 'Episode cover' })).toHaveStyle({ objectPosition: 'center center' });
  expect(screen.getAllByRole('img', { name: 'ModoItaliano' })).toHaveLength(1);
  expect(screen.getByRole('img', { name: 'ModoItaliano' })).toHaveAttribute('src', '/mi.svg');
  expect(screen.getByRole('img', { name: 'ModoItaliano' })).toHaveStyle({ top: '69px', left: '96px', width: '222px' });
  expect(screen.getAllByRole('img')).toHaveLength(2);
});

it('passes audio, master gain, timing and seeking through to the player', async () => {
  const { container, rerender } = render(<ModoItalianoGiorgiaPodcastPlayer audioUrl='/episode.mp3' masterGain={0.4} />);
  const audio = container.querySelector('audio')!;
  expect(audio.getAttribute('src')).toBe('/episode.mp3');
  expect(audio.volume).toBe(0.4);
  fireEvent.canPlay(audio);
  await waitFor(() => expect(audio.play).toHaveBeenCalled());
  Object.defineProperty(audio, 'duration', { configurable: true, value: 180 });
  fireEvent.durationChange(audio);
  fireEvent.change(screen.getByRole('slider'), { target: { value: '60' } });
  expect(audio.currentTime).toBe(60);
  fireEvent.timeUpdate(audio);
  expect(screen.getByText('1:00')).toBeInTheDocument();
  rerender(<ModoItalianoGiorgiaPodcastPlayer audioUrl='/episode.mp3' show={false} masterGain={0} />);
  expect(audio.muted).toBe(true);
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  expect(audio.pause).toHaveBeenCalled();
});

it('offers interaction when autoplay is blocked and reports media errors', async () => {
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new Error('blocked'));
  const { container } = render(<ModoItalianoGiorgiaPodcastPlayer audioUrl='/episode.mp3' />);
  const audio = container.querySelector('audio')!;
  fireEvent.canPlay(audio);
  expect(await screen.findByRole('button', { name: 'Start playback' })).toBeInTheDocument();
  fireEvent.error(audio);
  expect(screen.getByRole('alert')).toHaveTextContent('Unable to play this audio.');
});

// gaulatti/alcantara#184: the visualiser, sizing and the remaining guards.

/** A 2D context that records what the visualiser draws. */
function recordingCanvas() {
  const drawn: string[] = [];
  const context = {
    clearRect: () => drawn.push('clear'),
    fillRect: (_x: number, _y: number, width: number, height: number) =>
      drawn.push(`bar ${width}x${Math.round(height)}`),
    fillStyle: '',
    globalAlpha: 1,
  };
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context as never);
  return drawn;
}

/** Runs animation frames by hand instead of on the browser's clock. */
function manualFrames() {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  const cancel = vi.fn();
  vi.stubGlobal('cancelAnimationFrame', cancel);
  return { next: () => frames.shift()?.(0), cancel };
}

const reducedMotion = (matches: boolean) =>
  vi.stubGlobal('matchMedia', () => ({ matches }));

it('draws a flat line until audio plays, then the live spectrum', async () => {
  const drawn = recordingCanvas();
  const frames = manualFrames();
  reducedMotion(false);
  const spectrum = vi.fn((data: Uint8Array) => data.fill(255));
  vi.stubGlobal('AudioContext', class {
    destination = {};
    createAnalyser() {
      return { connect: vi.fn(), fftSize: 0, smoothingTimeConstant: 0, getByteFrequencyData: spectrum };
    }
    createMediaElementSource() { return { connect: vi.fn() }; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  });
  const { container, unmount } = render(<ModoItalianoGiorgiaPodcastPlayer audioUrl='/episode.mp3' />);
  expect(drawn).toEqual(['clear', 'bar 960x2']);
  const audio = container.querySelector('audio')!;
  fireEvent.canPlay(audio);
  await waitFor(() => expect(audio.play).toHaveBeenCalled());
  Object.defineProperty(audio, 'paused', { configurable: true, value: false });
  drawn.length = 0;
  frames.next();
  expect(spectrum).toHaveBeenCalled();
  expect(drawn[0]).toBe('clear');
  expect(drawn.slice(1)).toHaveLength(80);
  expect(drawn[1]).toBe('bar 5x100');
  unmount();
  expect(frames.cancel).toHaveBeenCalled();
});

it('keeps the flat line under reduced motion even while playing', async () => {
  const drawn = recordingCanvas();
  const frames = manualFrames();
  reducedMotion(true);
  const { container } = render(<ModoItalianoGiorgiaPodcastPlayer audioUrl='/episode.mp3' />);
  const audio = container.querySelector('audio')!;
  fireEvent.canPlay(audio);
  await waitFor(() => expect(audio.play).toHaveBeenCalled());
  Object.defineProperty(audio, 'paused', { configurable: true, value: false });
  drawn.length = 0;
  frames.next();
  expect(drawn).toEqual(['clear', 'bar 960x2']);
});

it('sizes the title to its length', () => {
  const { rerender } = render(<ModoItalianoGiorgiaPodcastPlayer episodeTitle='Breve' />);
  expect(screen.getByRole('heading')).toHaveStyle({ fontSize: '164px' });
  rerender(<ModoItalianoGiorgiaPodcastPlayer episodeTitle={'x'.repeat(61)} />);
  expect(screen.getByRole('heading')).toHaveStyle({ fontSize: '124px' });
  rerender(<ModoItalianoGiorgiaPodcastPlayer episodeTitle={'x'.repeat(91)} />);
  expect(screen.getByRole('heading')).toHaveStyle({ fontSize: '100px' });
  expect(screen.getByText('No cover selected')).toBeInTheDocument();
});

it('outlines the progress control while it has focus', () => {
  const { container } = render(<ModoItalianoGiorgiaPodcastPlayer audioUrl='/episode.mp3' />);
  const audio = container.querySelector('audio')!;
  Object.defineProperty(audio, 'duration', { configurable: true, value: 90 });
  fireEvent.durationChange(audio);
  const progress = screen.getByRole('slider', { name: 'Episode progress' });
  fireEvent.focus(progress);
  expect(progress.parentElement).toHaveStyle({ outline: '2px solid white' });
  fireEvent.blur(progress);
  expect(progress.parentElement).toHaveStyle({ outline: 'none' });
});

it('treats an unknown duration and an invalid gain as zero', () => {
  const { container } = render(
    <ModoItalianoGiorgiaPodcastPlayer audioUrl='/live.mp3' masterGain={Number.NaN} />,
  );
  const audio = container.querySelector('audio')!;
  expect(audio.volume).toBe(0);
  Object.defineProperty(audio, 'duration', { configurable: true, value: Infinity });
  fireEvent.durationChange(audio);
  expect(screen.getByRole('slider', { name: 'Episode progress' })).toBeDisabled();
  expect(screen.getAllByText('0:00')).toHaveLength(2);
});

it('reports a media error raised while starting, and ignores a ready event without audio', async () => {
  const { container, rerender } = render(<ModoItalianoGiorgiaPodcastPlayer audioUrl='/episode.mp3' />);
  const audio = container.querySelector('audio')!;
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() => {
    Object.defineProperty(audio, 'error', { configurable: true, value: { code: 4 } });
    return Promise.reject(new Error('unsupported'));
  });
  fireEvent.canPlay(audio);
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to play this audio.');
  expect(screen.queryByRole('button', { name: 'Start playback' })).toBeNull();

  vi.mocked(HTMLMediaElement.prototype.play).mockClear();
  rerender(<ModoItalianoGiorgiaPodcastPlayer audioUrl='' />);
  fireEvent.canPlay(audio);
  expect(audio.play).not.toHaveBeenCalled();
});
