import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { completeSceneCountdown } = vi.hoisted(() => ({ completeSceneCountdown: vi.fn() }));
vi.mock('../services/program', () => ({ completeSceneCountdown }));

import RelojDigitalLoopClock from './RelojDigitalLoopClock';

// gaulatti/alcantara#183: the Reloj digital clock's city loop, flight-board
// title, autoplay sequences and countdown stop.

const NOW = new Date('2026-11-17T15:00:25.340Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  completeSceneCountdown.mockReset();
});

const clock = (container: HTMLElement) => container.querySelector('#clock')!.textContent;
const city = (container: HTMLElement) => container.querySelector('#city-name')!.textContent;
const sequence = (mode: string, ...texts: string[]) => ({
  mode,
  intervalMs: 1000,
  startedAt: NOW.getTime(),
  items: texts.map((text, i) => ({ id: `i${i}`, kind: 'preset', text })),
});

it('shows the city time to the second and centiseconds, starting in Sanremo', () => {
  const view = render(<RelojDigitalLoopClock />);
  expect(clock(view.container)).toBe('16:00:25');
  expect(view.container.querySelector('#ms')!.textContent).toBe('34');
  expect(city(view.container)).toBe('SANREMO');
});

it('starts on the configured city, or Sanremo for one it does not tour', () => {
  expect(city(render(<RelojDigitalLoopClock timezone='America/New_York' />).container)).toBe('NEW YORK');
  cleanup();
  expect(city(render(<RelojDigitalLoopClock timezone='Asia/Tokyo' />).container)).toBe('SANREMO');
});

it('moves to the next city every half minute, fading the clock out first', async () => {
  const view = render(<RelojDigitalLoopClock timezone='America/Santiago' />);
  expect(city(view.container)).toBe('SANTIAGO');
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(view.container.querySelector('#clock-block')).toHaveClass('clock-out');
  await act(() => vi.advanceTimersByTimeAsync(600));
  expect(view.container.querySelector('#clock-block')).not.toHaveClass('clock-out');
  expect(city(view.container)).toBe('SANREMO');
  expect(clock(view.container)).toBe('16:00:30');
});

it('uses the device time format when the time zone data is unavailable', () => {
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
    throw new RangeError('time zones unavailable');
  });
  vi.spyOn(Date.prototype, 'toLocaleTimeString').mockReturnValue('16:00:25');
  expect(clock(render(<RelojDigitalLoopClock />).container)).toBe('16:00:25');
});

it('reads a missing time part as 00', () => {
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
    () => ({ formatToParts: () => [] }) as unknown as Intl.DateTimeFormat,
  );
  expect(clock(render(<RelojDigitalLoopClock />).container)).toBe('00:00:00');
});

it('lands the title letter by letter like a flight board', async () => {
  const view = render(<RelojDigitalLoopClock textSequence={sequence('manual', 'SANREMO 2027')} />);
  const title = () => view.container.querySelector('#show-title')!.textContent;
  await act(() => vi.advanceTimersByTimeAsync(45));
  expect(title()).toHaveLength('SANREMO 2027'.length);
  await act(() => vi.advanceTimersByTimeAsync(45 * 30));
  expect(title()).toBe('SANREMO 2027');
  // A shorter title keeps the leading characters while it settles.
  view.rerender(<RelojDigitalLoopClock textSequence={sequence('manual', 'LIVE')} />);
  await act(() => vi.advanceTimersByTimeAsync(45 * 30));
  expect(title()).toBe('LIVE');
});

it('advances autoplay title and call-to-action sequences', async () => {
  const view = render(
    <RelojDigitalLoopClock
      mode='countdown'
      textSequence={sequence('autoplay', 'ONE', 'TWO')}
      ctaSequence={sequence('autoplay', 'Soon', 'Now')}
    />,
  );
  expect(view.container.querySelector('#cta')!.textContent).toBe('Soon');
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(view.container.querySelector('#cta')!.textContent).toBe('Now');
});

it('stops a running countdown on the next command and holds it at zero', async () => {
  const countdown = (command: number, duration = 60) => (
    <RelojDigitalLoopClock mode='countdown' countdownDuration={duration} countdownCommand={command} />
  );
  const view = render(countdown(0));
  view.rerender(countdown(1));
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(clock(view.container)).toBe('00:00:50');
  // Changing the duration while running restarts it from the new length.
  view.rerender(countdown(1, 120));
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(clock(view.container)).toBe('00:01:59');
  view.rerender(countdown(2, 120));
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(clock(view.container)).toBe('00:00:00');
  expect(city(view.container)).toBe('');
  // An older or repeated command changes nothing.
  view.rerender(countdown(2, 120));
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(clock(view.container)).toBe('00:00:00');
  expect(completeSceneCountdown).not.toHaveBeenCalled();
});

it('shows hours on a long countdown', () => {
  const view = render(<RelojDigitalLoopClock mode='countdown' countdownDuration={3725} />);
  expect(clock(view.container)).toBe('01:02:05');
});

it('ignores a render without a countdown command after it started', async () => {
  const view = render(<RelojDigitalLoopClock mode='countdown' countdownDuration={60} countdownCommand={0} />);
  view.rerender(<RelojDigitalLoopClock mode='countdown' countdownDuration={60} />);
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(clock(view.container)).toBe('00:01:00');
  expect(city(view.container)).toBe('');
});
