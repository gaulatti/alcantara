import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AudioMeter } from './AudioMeter';

describe('AudioMeter', () => {
  afterEach(() => {
    cleanup();
  });
  it('renders with accessible meter attributes', () => {
    render(<AudioMeter level={60} label="Source audio meter" />);
    const meter = screen.getByRole('meter', { name: 'Source audio meter' });
    expect(meter).toBeInTheDocument();
    expect(meter).toHaveAttribute('aria-valuenow', '60');
    expect(meter).toHaveAttribute('aria-valuemin', '0');
    expect(meter).toHaveAttribute('aria-valuemax', '100');
    expect(screen.getByText('60%')).toBeInTheDocument();
  });

  it('clamps level between 0 and 100', () => {
    const { rerender } = render(<AudioMeter level={-15} />);
    let meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText('0%')).toBeInTheDocument();

    rerender(<AudioMeter level={150} />);
    meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('renders LED segments according to audio level', () => {
    render(<AudioMeter level={75} />);
    // 75% of 10 bars = 8 active bars (0 through 7)
    expect(screen.getByTestId('meter-bar-0')).toHaveClass('bg-emerald-500');
    expect(screen.getByTestId('meter-bar-5')).toHaveClass('bg-emerald-500');
    expect(screen.getByTestId('meter-bar-6')).toHaveClass('bg-amber-400');
    expect(screen.getByTestId('meter-bar-7')).toHaveClass('bg-amber-400');
    expect(screen.getByTestId('meter-bar-8')).toHaveClass('opacity-30');
    expect(screen.getByTestId('meter-bar-9')).toHaveClass('opacity-30');
  });
});

// gaulatti/alcantara#527: a frame that fires after the meter is torn down reads no analyser and stops, without
// scheduling another frame or touching the closed context.
describe('AudioMeter after teardown', () => {
  it('stops a frame that fires after unmount instead of scheduling another', () => {
    const scheduled: FrameRequestCallback[] = [];
    const live = new Set<number>();
    let nextId = 1;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextId++;
      scheduled.push(cb);
      live.add(id);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      live.delete(id);
    });
    class FakeTrack {}
    class FakeStream {
      constructor(_tracks: unknown[]) {}
    }
    vi.stubGlobal('MediaStreamTrack', FakeTrack);
    vi.stubGlobal('MediaStream', FakeStream);
    class FakeAudioContext {
      state = 'running';
      createAnalyser() {
        return { fftSize: 0, frequencyBinCount: 4, getByteFrequencyData: () => {} };
      }
      createMediaStreamSource() {
        return { connect: () => {}, disconnect: () => {} };
      }
      close() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal('AudioContext', FakeAudioContext);
    try {
      const { unmount } = render(<AudioMeter audioTrack={{ mediaStreamTrack: new FakeTrack() }} />);
      expect(scheduled).toHaveLength(1);
      unmount();
      expect(live.size).toBe(0);
      // The frame that was already on its way fires after teardown: it must stop, not schedule another frame.
      scheduled[0](0);
      expect(scheduled).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
