import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Slideshow } from './Slideshow';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Slideshow broadcast loading', () => {
  it('eagerly loads every frame and never advances to an unloaded image', () => {
    vi.useFakeTimers();
    render(<Slideshow images={['/roma-1.avif', '/roma-2.avif', '/roma-3.avif']} intervalMs={1000} kenBurns={false} />);

    const frames = screen.getAllByRole('img');
    frames.forEach((frame) => {
      expect(frame).toHaveAttribute('loading', 'eager');
      expect(frame).toHaveAttribute('decoding', 'async');
    });

    fireEvent.load(frames[0]);
    expect(frames[0]).toHaveStyle({ opacity: '1' });

    act(() => vi.advanceTimersByTime(1000));
    expect(frames[0]).toHaveStyle({ opacity: '1' });
    expect(frames[1]).toHaveStyle({ opacity: '0' });

    fireEvent.load(frames[1]);
    act(() => vi.advanceTimersByTime(1000));
    expect(frames[0]).toHaveStyle({ opacity: '0' });
    expect(frames[1]).toHaveStyle({ opacity: '1' });
  });
});
