import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToniClock } from './ToniClock';

// gaulatti/alcantara#183: the Toni corner clock.

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T15:04:00Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('shows the first default city when no cities are configured', () => {
  render(<ToniClock cities={[]} />);
  expect(screen.getByText('SANREMO')).toBeInTheDocument();
});

it('shows the configured cities inline', () => {
  const view = render(<ToniClock inline cities={[{ city: 'LIMA', timezone: 'America/Lima' }]} />);
  expect(screen.getByText('LIMA')).toBeInTheDocument();
  expect(view.container.firstChild).toHaveClass('toni-clock-corner--inline');
});

it('shows the bell logo or the bell icon', () => {
  const view = render(
    <ToniClock showWorldClocks={false} showBellIcon bellLogoUrl='https://cdn.example.test/bell.png' bellSize={40} />,
  );
  expect(screen.getByAltText('FifthBell logo')).toHaveStyle({ width: '40px', height: '40px' });
  view.rerender(<ToniClock showWorldClocks={false} showBellIcon />);
  expect(view.container.querySelector('.toni-clock-bell svg')).not.toBeNull();
  expect(screen.queryByAltText('FifthBell logo')).toBeNull();
});

it('shows nothing when both the clocks and the bell are off', () => {
  expect(render(<ToniClock showWorldClocks={false} />).container).toBeEmptyDOMElement();
});
