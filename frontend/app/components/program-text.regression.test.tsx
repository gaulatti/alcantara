import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FifthBellChyron } from './ToniChyron';
import RelojDigitalLoopClock from './RelojDigitalLoopClock';
import RelojLoopClock from './RelojLoopClock';

// Regression guard for the packaged moves (gaulatti/alcantara#422 follow-up): the text a viewer reads
// at load must be exactly what the program sets, not a later step of a timer.

const NOW = Date.parse('2026-11-23T15:00:00Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('shows the chyron slug as EN VIVO and the program text at load', () => {
  const { container } = render(<FifthBellChyron show text="URGENTE" />);
  expect(container.querySelector('.toni-chyron-slug-text')!.textContent).toBe('EN VIVO');
  expect(container.querySelector('.toni-chyron-text')!.textContent).toBe('URGENTE');
});

it('shows the program timezone city on the digital clock at load', () => {
  const { container } = render(<RelojDigitalLoopClock timezone="America/New_York" />);
  expect(container.querySelector('#city-name')!.textContent).toBe('NEW YORK');
});

it('shows the program timezone city on the loop clock at load', () => {
  const { container } = render(<RelojLoopClock timezone="Europe/Madrid" />);
  expect(container.querySelector('.reloj-loop-city-label')!.textContent).toBe('MADRID');
});

it('holds the load text until the next slug change', () => {
  const { container } = render(<FifthBellChyron show text="URGENTE" />);
  act(() => {
    vi.advanceTimersByTime(3900);
  });
  expect(container.querySelector('.toni-chyron-slug-text')!.textContent).toBe('EN VIVO');
});
