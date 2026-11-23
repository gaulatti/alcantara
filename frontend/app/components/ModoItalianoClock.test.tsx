import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProgramAudioBusSnapshot } from '../utils/programAudioBus';

// gaulatti/alcantara#183: the Modo Italiano clock's city tour, time override,
// logo and bell layouts, song sources and the song playing on the program
// audio bus. The audio bus is the browser's audio engine; a stand-in
// publishes its snapshots here.

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

import { ModoItalianoClock } from './ModoItalianoClock';

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
const badge = (container: HTMLElement) => container.querySelector('span') as HTMLElement;
const wrapper = (container: HTMLElement) => container.firstElementChild as HTMLElement;
// The song card: the box that follows the "Estás escuchando:" row (or the style block).
const card = (container: HTMLElement) => wrapper(container).querySelector(':scope > div:last-child') as HTMLElement;
const listening = () => screen.queryByText('Estás escuchando:');
const live = (token: string, details: Partial<NonNullable<ProgramAudioBusSnapshot['track']>> = {}) => ({
  ...bus.idle,
  track: { token, audioUrl: `https://media.example.test/${token}.mp3`, ...details },
  isPlaying: true,
});

it('tours the cities with a fade and starts again after the last one', () => {
  const view = render(<ModoItalianoClock programId='p' rotationIntervalMs={1000} transitionDurationMs={200} />);
  expect(badge(view.container).textContent).toBe('16:04 IT');
  step(1000);
  // The badge dims while the next city fades in.
  expect(badge(view.container).style.opacity).toBe('0.35');
  expect(badge(view.container).textContent).toBe('16:04 IT');
  step(200);
  expect(badge(view.container).style.opacity).toBe('1');
  expect(badge(view.container).textContent).toBe('16:04 ES');
  step(1200 * 3);
  expect(badge(view.container).textContent).toBe('10:04 NY');
  step(1200);
  expect(badge(view.container).textContent).toBe('16:04 IT');
});

it('keeps each city on air for at least half a second, and never fades for less than nothing', () => {
  const view = render(<ModoItalianoClock programId='p' rotationIntervalMs={10} transitionDurationMs={-50} />);
  step(499);
  expect(badge(view.container).textContent).toBe('16:04 IT');
  // A zero-length fade still lands on the next timer tick.
  step(2);
  expect(badge(view.container).textContent).toBe('16:04 ES');
});

it('clears a fade in flight when it unmounts', () => {
  const clearTimeout = vi.spyOn(window, 'clearTimeout');
  const view = render(<ModoItalianoClock programId='p' rotationIntervalMs={1000} transitionDurationMs={300} />);
  step(1000);
  view.unmount();
  expect(clearTimeout).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('shuffles the cities, and shuffles again after each tour', () => {
  const random = vi.spyOn(Math, 'random').mockReturnValue(0);
  const view = render(<ModoItalianoClock programId='p' shuffleCities rotationIntervalMs={500} transitionDurationMs={0} />);
  // Math.random() = 0 moves each city to the front in turn: the tour starts at the second city.
  expect(badge(view.container).textContent).toMatch(/ ES$/);
  const calls = random.mock.calls.length;
  // Each city change lands one tick after its zero-length fade.
  step(501 * 5);
  expect(random.mock.calls.length).toBeGreaterThan(calls);
  expect(badge(view.container).textContent).toMatch(/ (IT|ES|UY|CL|NY)$/);
});

it('runs the operator time override', () => {
  const view = render(
    <ModoItalianoClock programId='p' timeOverride={{ startTime: '21:30', startedAt: '2026-11-17T15:02:00Z' }} />,
  );
  expect(badge(view.container).textContent).toBe('21:32 IT');
});

it('uses the zone time when the override cannot be read', () => {
  const view = render(<ModoItalianoClock programId='p' timeOverride={{ startTime: 'later', startedAt: 'soon' }} />);
  expect(badge(view.container).textContent).toBe('16:04 IT');
});

it('uses the device time when the time zone data is unavailable', () => {
  const real = Date.prototype.toLocaleTimeString;
  vi.spyOn(Date.prototype, 'toLocaleTimeString').mockImplementation(function (this: Date, locale, options) {
    if (options?.timeZone) throw new RangeError('time zones unavailable');
    return real.call(this, locale, options);
  });
  const view = render(<ModoItalianoClock programId='p' />);
  expect(badge(view.container).textContent).toMatch(/^\d{2}:\d{2} IT$/);
});

it('ticks the clock every second', () => {
  const view = render(<ModoItalianoClock programId='p' rotationIntervalMs={600000} />);
  step(60000);
  expect(badge(view.container).textContent).toBe('16:05 IT');
});

it('sizes the clock badge to the configured width, never below its minimum', () => {
  const wide = render(<ModoItalianoClock programId='p' widthPx={300} />);
  expect((badge(wide.container).parentElement as HTMLElement).style.minWidth).toBe('300px');
  cleanup();
  const narrow = render(<ModoItalianoClock programId='p' widthPx={10} />);
  expect((badge(narrow.container).parentElement as HTMLElement).style.minWidth).toBe('176px');
  expect((badge(narrow.container).parentElement!.parentElement as HTMLElement).style.minWidth).toBe('160px');
});

it('renders nothing with the clocks, the bell and the logo all off', () => {
  const view = render(
    <ModoItalianoClock programId='p' showWorldClocks={false} showBellIcon={false} showLogo={false} songArtist='Mina' />,
  );
  expect(view.container).toBeEmptyDOMElement();
});

it('shows only the logo, in the corner or inline, when the clocks are off and no song plays', () => {
  const corner = render(<ModoItalianoClock programId='p' showWorldClocks={false} />);
  expect(screen.getByRole('img', { name: 'MI' })).toBeInTheDocument();
  expect(wrapper(corner.container).style.position).toBe('absolute');
  expect(badge(corner.container)).toBeNull();
  cleanup();
  const inline = render(<ModoItalianoClock programId='p' showWorldClocks={false} inline />);
  expect(wrapper(inline.container).style.position).toBe('');
  expect(wrapper(inline.container).style.width).toBe('fit-content');
});

it('puts the logo beside the song when the clocks are off', () => {
  const view = render(<ModoItalianoClock programId='p' showWorldClocks={false} songArtist='Mina' songTitle='Uno' />);
  expect(listening()).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'MI' })).toBeInTheDocument();
  expect(badge(view.container)).toBeNull();
});

it('shows the bell, with or without the logo and clocks', () => {
  const view = render(<ModoItalianoClock programId='p' showWorldClocks={false} showLogo={false} showBellIcon rotationIntervalMs={500} />);
  step(2000);
  expect(view.container.querySelector('svg.lucide-bell-ring')).not.toBeNull();
  expect(screen.queryByRole('img', { name: 'MI' })).toBeNull();
  cleanup();
  render(<ModoItalianoClock programId='p' showBellIcon />);
  expect(document.querySelector('svg.lucide-bell-ring')).not.toBeNull();
  expect(screen.getAllByRole('img', { name: 'MI' })).toHaveLength(1);
});

it('spreads the song card across the screen beside the clocks, in the corner or inline', () => {
  const corner = render(<ModoItalianoClock programId='p' songArtist='Mina' songTitle='Uno' songCoverUrl='https://media.example.test/c.jpg' />);
  expect(wrapper(corner.container).style.width).toMatch(/^min\(1420px/);
  expect(card(corner.container).style.justifyContent).toBe('space-between');
  expect(card(corner.container).style.background).toContain('linear-gradient');
  expect(screen.getByAltText('Cover')).toHaveAttribute('src', 'https://media.example.test/c.jpg');
  expect(screen.getByText('Uno')).toBeInTheDocument();
  expect(screen.getByText('Mina').style.marginTop).toBe('8px');
  cleanup();
  const inline = render(<ModoItalianoClock programId='p' inline songArtist='Mina' />);
  expect(wrapper(inline.container).style.width).toBe('100%');
  expect(screen.getByText('Mina').style.marginTop).toBe('0px');
  expect(screen.getByAltText('Cover')).toHaveAttribute('src', '/cover.jpg');
});

it('shows the title alone when there is no artist', () => {
  render(<ModoItalianoClock programId='p' playingSong songTitle='Vita' />);
  expect(screen.getByText('Vita')).toBeInTheDocument();
  expect(listening()).toBeInTheDocument();
});

it('keeps the clock on its own while no song plays', () => {
  const view = render(<ModoItalianoClock programId='p' />);
  expect(listening()).toBeNull();
  expect(card(view.container).style.background).toBe('transparent');
  expect(card(view.container).style.animation).toBe('');
  expect(wrapper(view.container).style.width).toBe('fit-content');
});

it('hides the configured song when the program says no song is playing', () => {
  render(<ModoItalianoClock programId='p' playingSong={false} songArtist='Mina' songTitle='Uno' />);
  expect(listening()).toBeNull();
});

it('takes the first usable song from a song list', () => {
  const songs = [
    null,
    ['not a song'],
    { artist: 7, title: '  ' },
    { audioUrl: 'https://media.example.test/a.mp3', durationMs: -1 },
    { artist: ' Lucio Dalla ', title: 'Caruso', coverUrl: 'https://media.example.test/c.jpg', durationMs: 240000 },
  ];
  const view = render(<ModoItalianoClock programId='p' songs={songs} />);
  // The audio-only entry is usable but has neither artist nor title, so nothing shows.
  expect(listening()).toBeNull();
  view.rerender(<ModoItalianoClock programId='p' songs={songs.slice(0, 3).concat(songs.slice(4))} />);
  step(500);
  expect(screen.getByText('Lucio Dalla')).toBeInTheDocument();
  expect(screen.getByAltText('Cover')).toHaveAttribute('src', 'https://media.example.test/c.jpg');
});

it('accepts a song with only its EarOne chart details', () => {
  const view = render(<ModoItalianoClock programId='p' songs={[{ earoneSongId: 42 }, { artist: 'Shown' }]} />);
  // The first entry is usable, so it is the song, and it has nothing to show.
  expect(listening()).toBeNull();
  for (const song of [{ earoneSongId: ' 42 ' }, { earoneRank: ' 3 ' }, { earoneSpins: 120 }, { earoneSpins: ' 120 ' }]) {
    view.rerender(<ModoItalianoClock programId='p' songs={[song, { artist: 'Shown' }]} />);
    expect(screen.queryByText('Shown')).toBeNull();
  }
  view.rerender(
    <ModoItalianoClock programId='p' songs={[{ earoneSongId: NaN, earoneRank: ' ', earoneSpins: Infinity }, { artist: 'Shown' }]} />,
  );
  expect(screen.getByText('Shown')).toBeInTheDocument();
});

it('prefers the song fields over the song list', () => {
  render(
    <ModoItalianoClock
      programId='p'
      songArtist='Field artist'
      songEaroneSongId='9'
      songEaroneRank='1'
      songEaroneSpins='50'
      songs={[{ artist: 'List artist' }]}
    />,
  );
  expect(screen.getByText('Field artist')).toBeInTheDocument();
  expect(screen.queryByText('List artist')).toBeNull();
});

it('shows nothing from a song list without a usable song', () => {
  const view = render(<ModoItalianoClock programId='p' songs={[{}]} />);
  expect(listening()).toBeNull();
  view.rerender(<ModoItalianoClock programId='p' songs='Caruso' />);
  expect(listening()).toBeNull();
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
  const view = render(<ModoItalianoClock programId='p' songSequence={songSequence} />);
  expect(screen.getByText('Mina')).toBeInTheDocument();
  step(1000);
  expect(screen.getByText('Dalla')).toBeInTheDocument();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('shows the song playing on the program audio bus, with its progress', () => {
  const view = render(<ModoItalianoClock programId='p' songArtist='Fallback' />);
  act(() =>
    bus.publish({
      ...live('t1', { artist: 'Live artist', title: 'Live title', coverUrl: 'https://media.example.test/live.jpg' }),
      progress: 1.4,
    }),
  );
  expect(screen.getByText('Live artist')).toBeInTheDocument();
  expect(screen.getByAltText('Cover')).toHaveAttribute('src', 'https://media.example.test/live.jpg');
  // The card's first child is its red overlay; the progress layer and its edge follow it.
  const [overlay, progress, edge] = Array.from(card(view.container).children) as HTMLElement[];
  expect(overlay.style.opacity).toBe('0');
  expect(progress.style.transform).toBe('scaleX(1)');
  expect(progress.style.opacity).toBe('1');
  expect(edge.style.left).toBe('100%');
  expect(edge.style.opacity).toBe('1');
});

it('hides the progress when the program turns it off', () => {
  const view = render(<ModoItalianoClock programId='p' showPlaybackProgress={false} />);
  act(() => bus.publish({ ...live('t1', { artist: 'Live artist' }), progress: 0.5 }));
  const progress = card(view.container).children[1] as HTMLElement;
  expect(progress.style.transform).toBe('scaleX(0.5)');
  expect(progress.style.opacity).toBe('0');
});

it('ignores the audio bus while the program says no song is playing', () => {
  render(<ModoItalianoClock programId='p' playingSong={false} />);
  act(() => bus.publish(live('t1', { artist: 'Live artist' })));
  expect(listening()).toBeNull();
});

it('falls back to the configured song when the live track has no details', () => {
  const view = render(
    <ModoItalianoClock programId='p' playingSong songArtist='Configured' songTitle='Song' songCoverUrl='https://media.example.test/s.jpg' />,
  );
  act(() => bus.publish({ ...live('t2'), progress: -0.2 }));
  expect(screen.getByText('Configured')).toBeInTheDocument();
  expect(screen.getByAltText('Cover')).toHaveAttribute('src', 'https://media.example.test/s.jpg');
  expect((card(view.container).children[1] as HTMLElement).style.transform).toBe('scaleX(0)');
});

it('moves the song in and out of the card as the live track starts and ends', () => {
  const view = render(<ModoItalianoClock programId='p' />);
  expect(listening()).toBeNull();
  act(() => bus.publish(live('t1', { artist: 'Live artist', title: 'Live title' })));
  // The card grows in; the song row fades in on the next animation frame.
  expect(card(view.container).style.animation).toContain('modoItalianoClockSongBoxIn');
  expect((listening()!.parentElement as HTMLElement).style.opacity).toBe('0');
  step(32);
  expect((listening()!.parentElement as HTMLElement).style.opacity).toBe('1');
  step(328);
  expect(card(view.container).style.animation).toBe('modoItalianoClockBgFlow 8s ease-in-out infinite');

  // The bus reports the track ended: the song fades out, then the card shrinks.
  act(() => bus.publish({ ...bus.get(), endedToken: 't1' }));
  expect(card(view.container).style.animation).toContain('modoItalianoClockSongBoxOut');
  expect((listening()!.parentElement as HTMLElement).style.opacity).toBe('0');
  step(320);
  expect(listening()).toBeNull();
  expect(screen.queryByText('Live artist')).toBeNull();
  expect(card(view.container).style.animation).toContain('modoItalianoClockSongBoxOut 360ms');
  step(40);
  expect(card(view.container).style.animation).toBe('');
});

it('cancels the song motion in flight when it unmounts', () => {
  const view = render(<ModoItalianoClock programId='p' showWorldClocks={false} />);
  act(() => bus.publish(live('t1', { artist: 'Live artist' })));
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
  cleanup();

  const leaving = render(<ModoItalianoClock programId='p' showWorldClocks={false} />);
  act(() => bus.publish(live('t2', { artist: 'Live artist' })));
  step(400);
  act(() => bus.publish({ ...bus.get(), endedToken: 't2' }));
  leaving.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
