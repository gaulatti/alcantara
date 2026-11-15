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

  it('shows the first image at once, without fading up from black, then fades between images', () => {
    vi.useFakeTimers();
    render(<Slideshow images={['/a.avif', '/b.avif']} intervalMs={1000} transitionMs={400} kenBurns={false} />);
    const [first, second] = screen.getAllByRole('img');

    expect(first.style.transition).toBe('none');
    fireEvent.load(first);
    expect(first).toHaveStyle({ opacity: '1' });
    expect(first.style.transition).toBe('none');

    // After the first image has painted, later changes fade.
    act(() => vi.advanceTimersByTime(50));
    expect(first.style.transition).toBe('opacity 400ms ease-in-out');
    expect(second.style.transition).toBe('opacity 400ms ease-in-out');
  });

  it('keeps the outgoing image moving until its fade-out ends, so it never snaps back to size', () => {
    vi.useFakeTimers();
    render(<Slideshow images={['/a.avif', '/b.avif']} intervalMs={1000} transitionMs={400} />);
    const [first, second] = screen.getAllByRole('img');
    fireEvent.load(first);
    fireEvent.load(second);
    act(() => vi.advanceTimersByTime(50));
    const firstMotion = first.style.animation;
    expect(firstMotion).toContain('slideshowKenBurns0');
    expect(second.style.animation).toBe('');

    // The switch: the second image starts its own motion, the first keeps the one it had.
    act(() => vi.advanceTimersByTime(950));
    expect(second).toHaveStyle({ opacity: '1' });
    expect(first).toHaveStyle({ opacity: '0' });
    expect(second.style.animation).toContain('slideshowKenBurns1');
    expect(first.style.animation).toBe(firstMotion);

    // Only once it is invisible is the motion dropped.
    act(() => vi.advanceTimersByTime(399));
    expect(first.style.animation).toBe(firstMotion);
    act(() => vi.advanceTimersByTime(1));
    expect(first.style.animation).toBe('');
    expect(second.style.animation).toContain('slideshowKenBurns1');
  });

  it('restarts the motion of an image when it comes back', () => {
    vi.useFakeTimers();
    render(<Slideshow images={['/a.avif', '/b.avif']} intervalMs={1000} transitionMs={400} />);
    const [first, second] = screen.getAllByRole('img');
    fireEvent.load(first);
    fireEvent.load(second);
    act(() => vi.advanceTimersByTime(1000));
    act(() => vi.advanceTimersByTime(1000));
    expect(first).toHaveStyle({ opacity: '1' });
    // A different animation name than its first run, which is what makes the browser start it again.
    expect(first.style.animation).toContain('slideshowKenBurns0');
    expect(second.style.animation).toContain('slideshowKenBurns1');
    act(() => vi.advanceTimersByTime(1000));
    expect(second.style.animation).toContain('slideshowKenBurns1');
  });

  it('keeps its images in their own layer so components placed over it stay on top', () => {
    const { container } = render(<Slideshow images={['/a.avif']} kenBurns={false} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.isolation).toBe('isolate');
    expect(root.style.zIndex).toBe('');
  });
});
