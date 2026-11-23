import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClockWidget } from './ClockWidget';

// gaulatti/alcantara#183: the generic broadcast clock.

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T15:04:00Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('shows the time in the configured time zone and ticks every second', () => {
  const view = render(<ClockWidget timezone='America/New_York' />);
  expect(view.container.querySelector('.clock-time')).toHaveTextContent('10:04');
  act(() => vi.advanceTimersByTime(60_000));
  expect(view.container.querySelector('.clock-time')).toHaveTextContent('10:05');
});

it('defaults to Buenos Aires time with an empty icon slot', () => {
  const view = render(<ClockWidget />);
  expect(view.container.querySelector('.clock-time')).toHaveTextContent('12:04');
  expect(view.container.querySelector('.clock-icon')).toBeEmptyDOMElement();
});

it('shows the icon image, or no icon slot at all', () => {
  const view = render(<ClockWidget iconUrl='https://cdn.example.test/icon.png' />);
  expect(screen.getByAltText('icon')).toHaveAttribute('src', 'https://cdn.example.test/icon.png');
  view.rerender(<ClockWidget showIcon={false} />);
  expect(view.container.querySelector('.clock-icon')).toBeNull();
});

it('runs the operator time override from its start time', () => {
  const view = render(
    <ClockWidget timeOverride={{ startTime: '21:30', startedAt: '2026-11-17T15:02:00Z' }} />,
  );
  expect(view.container.querySelector('.clock-time')).toHaveTextContent('21:32');
});

it('falls back to the zone time for an override it cannot read', () => {
  const view = render(
    <ClockWidget timezone='America/New_York' timeOverride={{ startTime: 'late', startedAt: '2026-11-17T15:02:00Z' }} />,
  );
  expect(view.container.querySelector('.clock-time')).toHaveTextContent('10:04');
});

it('shows the device time when the time zone is invalid', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const now = new Date();
  const view = render(<ClockWidget timezone='Not/AZone' />);
  const expected = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  expect(view.container.querySelector('.clock-time')).toHaveTextContent(expected);
  expect(error).toHaveBeenCalledWith('Invalid timezone:', 'Not/AZone');
});
