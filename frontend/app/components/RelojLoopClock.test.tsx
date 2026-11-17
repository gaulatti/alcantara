import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RelojLoopClock from './RelojLoopClock';

// gaulatti/alcantara#183: the analogue loop clock that tours four cities.

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T15:00:58Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const label = (container: HTMLElement) => container.querySelector('.reloj-loop-city-label')!;
const secondHand = (container: HTMLElement) => container.querySelectorAll('svg line')[14];

it('starts on the configured city and moves to the next at the top of each minute', () => {
  const view = render(<RelojLoopClock timezone='America/New_York' />);
  expect(label(view.container)).toHaveTextContent('NEW YORK');
  act(() => vi.advanceTimersByTime(2000));
  expect(label(view.container)).toHaveClass('reloj-loop-city-label--out');
  expect(view.container.querySelector('svg')).toHaveClass('reloj-loop-analog--out');
  act(() => vi.advanceTimersByTime(500));
  expect(label(view.container)).toHaveTextContent('SANTIAGO');
  expect(label(view.container)).not.toHaveClass('reloj-loop-city-label--out');
  act(() => vi.advanceTimersByTime(60_000));
  expect(label(view.container)).toHaveTextContent('MADRID');
});

it('starts on Madrid for an unknown or missing time zone', () => {
  expect(label(render(<RelojLoopClock timezone='Asia/Tokyo' />).container)).toHaveTextContent('MADRID');
  cleanup();
  expect(label(render(<RelojLoopClock />).container)).toHaveTextContent('MADRID');
});

it('draws twelve markers and three hands that follow the time', () => {
  const view = render(<RelojLoopClock />);
  expect(view.container.querySelectorAll('svg line')).toHaveLength(15);
  const before = secondHand(view.container).getAttribute('x2');
  act(() => vi.advanceTimersByTime(1000));
  expect(secondHand(view.container).getAttribute('x2')).not.toBe(before);
});

it('uses the device time when the time zone data is unavailable', () => {
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
    throw new RangeError('time zones unavailable');
  });
  const view = render(<RelojLoopClock />);
  // 58 seconds: the second hand points 348 degrees round, just left of twelve.
  expect(Number(secondHand(view.container).getAttribute('x2'))).toBeLessThan(0);
});

it('reads a missing time part as zero', () => {
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
    () => ({ formatToParts: () => [] }) as unknown as Intl.DateTimeFormat,
  );
  const view = render(<RelojLoopClock />);
  // Every hand at twelve: the far end of each hand is straight up (x = 0).
  for (const index of [12, 13, 14]) {
    expect(Number(view.container.querySelectorAll('svg line')[index].getAttribute('x2'))).toBeCloseTo(0);
  }
});
