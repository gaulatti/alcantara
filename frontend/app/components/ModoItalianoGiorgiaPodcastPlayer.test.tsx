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
