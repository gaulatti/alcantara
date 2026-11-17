import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProgramAudioBusSnapshot } from '../utils/programAudioBus';

// gaulatti/alcantara#183: the Giorgia clock's city tour, time override, song
// sources and the song playing on the program audio bus. The audio bus is
// the browser's audio engine; a stand-in publishes its snapshots here.

const bus = vi.hoisted(() => {
  const listeners = new Set<(snapshot: ProgramAudioBusSnapshot) => void>();
  const idle: ProgramAudioBusSnapshot = {
    track: null,
    progress: 0,
    currentTimeMs: 0,
    durationMs: null,
    endedToken: '',
    isPlaying: false,
  };
  let snapshot = idle;
  return {
    idle,
    reset() {
      snapshot = idle;
      listeners.clear();
    },
    publish(next: ProgramAudioBusSnapshot) {
      snapshot = next;
      for (const listener of listeners) listener(next);
    },
    get: () => snapshot,
    subscribe(listener: (snapshot: ProgramAudioBusSnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
vi.mock('../utils/programAudioBus', () => ({
  getProgramAudioBusSnapshot: () => bus.get(),
  subscribeProgramAudioBus: (_programId: string, listener: (snapshot: ProgramAudioBusSnapshot) => void) =>
    bus.subscribe(listener),
}));

import { ModoItalianoGiorgiaClock } from './ModoItalianoGiorgiaClock';

const NOW = new Date('2026-11-17T15:04:00Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  bus.reset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const step = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const headerText = (container: HTMLElement) =>
  container.querySelector('.modoitaliano-giorgia-clock-header')!.textContent;
const hero = (container: HTMLElement) =>
  container.querySelector('.modoitaliano-giorgia-clock-hero')?.textContent;

it('tours the cities in order and starts again after the last one', () => {
  const view = render(<ModoItalianoGiorgiaClock programId='p' rotationIntervalMs={1000} />);
  expect(headerText(view.container)).toBe('16:04 IT');
  step(1000);
  expect(headerText(view.container)).toBe('16:04 ES');
  step(3000);
  expect(headerText(view.container)).toBe('10:04 NY');
  step(1000);
  expect(headerText(view.container)).toBe('16:04 IT');
});

it('shuffles the cities, and shuffles again after each tour', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const view = render(<ModoItalianoGiorgiaClock programId='p' shuffleCities rotationIntervalMs={500} />);
  // Math.random() = 0 moves each city to the front in turn: the tour starts at the second city.
  expect(headerText(view.container)).toMatch(/ ES$/);
  step(500 * 5);
  expect(headerText(view.container)).toMatch(/ (IT|ES|UY|CL|NY)$/);
});

it('stays on the first city when the clocks are off', () => {
  const view = render(<ModoItalianoGiorgiaClock programId='p' showWorldClocks={false} showBellIcon rotationIntervalMs={500} />);
  step(2000);
  expect(view.container.querySelector('.modoitaliano-giorgia-clock-header svg.lucide-bell-ring')).not.toBeNull();
});

it('runs the operator time override', () => {
  const view = render(
    <ModoItalianoGiorgiaClock programId='p' timeOverride={{ startTime: '21:30', startedAt: '2026-11-17T15:02:00Z' }} />,
  );
  expect(headerText(view.container)).toBe('21:32 IT');
});

it('uses the device time when the time zone data is unavailable', () => {
  const real = Date.prototype.toLocaleTimeString;
  vi.spyOn(Date.prototype, 'toLocaleTimeString').mockImplementation(function (this: Date, locale, options) {
    if (options?.timeZone) throw new RangeError('time zones unavailable');
    return real.call(this, locale, options);
  });
  const view = render(<ModoItalianoGiorgiaClock programId='p' />);
  expect(headerText(view.container)).toMatch(/^\d{2}:\d{2} IT$/);
});

it('labels the on-air block in Italian and English', () => {
  const song = { playingSong: true, songArtist: 'Mina', songTitle: 'Se telefonando' };
  expect(render(<ModoItalianoGiorgiaClock programId='p' language='it' {...song} />).container.textContent).toContain('In onda ora');
  cleanup();
  expect(render(<ModoItalianoGiorgiaClock programId='p' language='en' {...song} />).container.textContent).toContain('On air now');
});

it('leads with the title when there is no artist', () => {
  const view = render(<ModoItalianoGiorgiaClock programId='p' playingSong songTitle='Vita' />);
  expect(hero(view.container)).toBe('VITA');
  expect(view.container.querySelector('.modoitaliano-giorgia-clock-on-air')!.textContent).not.toContain('VITA VITA');
});

it('takes the first usable song from a song list', () => {
  const songs = [
    null,
    ['not a song'],
    { artist: 7, title: '  ' },
    { audioUrl: 'https://media.example.test/a.mp3', durationMs: -1 },
    { artist: ' Lucio Dalla ', title: 'Caruso', coverUrl: 'https://media.example.test/c.jpg', durationMs: 240000 },
  ];
  const view = render(<ModoItalianoGiorgiaClock programId='p' songs={songs} />);
  // The audio-only entry is usable but has neither artist nor title, so nothing shows.
  expect(view.container.querySelector('.modoitaliano-giorgia-clock-on-air')).toBeNull();
  view.rerender(<ModoItalianoGiorgiaClock programId='p' songs={songs.slice(0, 3).concat(songs.slice(4))} />);
  step(500);
  expect(hero(view.container)).toBe('LUCIO DALLA');
  expect(view.container.querySelector('.modoitaliano-giorgia-clock-on-air img')).toHaveAttribute('src', 'https://media.example.test/c.jpg');
});

it('shows nothing from a song list without a usable song', () => {
  const view = render(<ModoItalianoGiorgiaClock programId='p' songs={[{}]} />);
  expect(view.container.querySelector('.modoitaliano-giorgia-clock-on-air')).toBeNull();
  view.rerender(<ModoItalianoGiorgiaClock programId='p' songs='Caruso' />);
  expect(view.container.querySelector('.modoitaliano-giorgia-clock-on-air')).toBeNull();
});

it('plays an autoplay song sequence, each song for its length', () => {
  const songSequence = {
    mode: 'autoplay',
    intervalMs: 1000,
    startedAt: NOW.getTime(),
    items: [
      { id: 'a', kind: 'preset', artist: 'Mina', title: 'Uno', durationMs: 1000 },
      { id: 'b', kind: 'preset', artist: 'Dalla', title: 'Due', durationMs: 1000 },
    ],
  };
  const view = render(<ModoItalianoGiorgiaClock programId='p' songSequence={songSequence} />);
  expect(hero(view.container)).toBe('MINA');
  step(1000);
  expect(hero(view.container)).toBe('DALLA');
});

it('shows the song playing on the program audio bus, with its progress', () => {
  const view = render(<ModoItalianoGiorgiaClock programId='p' songArtist='Fallback' />);
  act(() =>
    bus.publish({
      ...bus.idle,
      track: { token: 't1', audioUrl: 'https://media.example.test/live.mp3', artist: 'Live artist', title: 'Live title', coverUrl: 'https://media.example.test/live.jpg' },
      progress: 1.4,
      isPlaying: true,
    }),
  );
  expect(hero(view.container)).toBe('LIVE ARTIST');
  const bar = view.container.querySelector('.modoitaliano-giorgia-clock-progress > div') as HTMLElement;
  expect(bar.style.transform).toBe('scaleX(1)');
  // The bus reports the track ended: the block leaves.
  act(() => bus.publish({ ...bus.get(), endedToken: 't1' }));
  step(450);
  expect(view.container.querySelector('.modoitaliano-giorgia-clock-on-air')).toBeNull();
});

it('falls back to the configured song when the live track has no details', () => {
  const view = render(<ModoItalianoGiorgiaClock programId='p' playingSong songArtist='Configured' songTitle='Song' songCoverUrl='https://media.example.test/s.jpg' />);
  act(() => bus.publish({ ...bus.idle, track: { token: 't2', audioUrl: 'https://media.example.test/x.mp3' }, progress: -0.2 }));
  expect(hero(view.container)).toBe('CONFIGURED');
  expect(view.container.querySelector('.modoitaliano-giorgia-clock-on-air img')).toHaveAttribute('src', 'https://media.example.test/s.jpg');
  expect((view.container.querySelector('.modoitaliano-giorgia-clock-progress > div') as HTMLElement).style.transform).toBe('scaleX(0)');
});

it('shows nothing for an on-air-only part with no song', () => {
  expect(render(<ModoItalianoGiorgiaClock programId='p' part='onAir' />).container).toBeEmptyDOMElement();
});

it('puts the header on its own navy plate for a chroma-key scene', () => {
  const view = render(<ModoItalianoGiorgiaClock programId='p' keySafe playingSong songArtist='Mina' songTitle='Uno' />);
  const header = view.container.querySelector('.modoitaliano-giorgia-clock-header') as HTMLElement;
  expect(header.style.background).not.toBe('');
  expect(header.querySelector('span')!.style.textShadow).toBe('none');
  expect((view.container.querySelector('.modoitaliano-giorgia-clock-hero') as HTMLElement).style.textShadow).toBe('none');
});
