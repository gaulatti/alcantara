import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// gaulatti/alcantara#285: the <audio> element mounts only after data loads, so the
// preload and master-gain effects must run once it exists, not on the first render.

vi.mock('../../hooks/useSSE', () => ({ useSSE: () => ({ isConnected: false }) }));
vi.mock('./events', () => ({
  fetchEvents: vi.fn(async () => []),
  getCachedEvents: vi.fn(() => []),
  hasEventChanges: vi.fn(() => false)
}));
vi.mock('./segments', () => {
  const stubSegment = () => ({ durationMsPerItem: 0, render: () => null, onEnter: () => {} });
  return {
    createArticlesSegment: vi.fn(stubSegment),
    createWeatherSegment: vi.fn(stubSegment),
    createEarthquakeSegment: vi.fn(stubSegment),
    createMarketsSegment: vi.fn(stubSegment),
  fetchArticles: vi.fn(async () => []),
  fetchWeatherData: vi.fn(async () => []),
  fetchEarthquakes: vi.fn(async () => []),
  fetchMarketData: vi.fn(async () => []),
  usePlaylistEngine: () => ({
    state: { currentSegmentIndex: 0, currentItemIndex: 0, progress: 0, isPaused: false },
    currentSegment: null,
    pause: vi.fn(),
    resume: vi.fn(),
    reset: vi.fn()
  })
  };
});
vi.mock('./components/Marquee', () => ({ default: () => null }));
vi.mock('./components/MarqueeCurtain', () => ({ MarqueeCurtain: () => null }));
vi.mock('./components/slides/CallsignSlide', () => ({ CallsignSlide: () => null }));

import FifthBellProgram from './FifthBellProgram';

let loadSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 200 })));
  loadSpy = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountedAudio(masterGain: number) {
  const view = render(<FifthBellProgram masterGain={masterGain} embedded />);
  await waitFor(() => expect(view.container.querySelector('audio')).not.toBeNull());
  return { view, audio: view.container.querySelector('audio') as HTMLAudioElement };
}

describe('FifthBellProgram audio', () => {
  it('applies a non-default master gain at mount once data has loaded', async () => {
    const { audio } = await mountedAudio(0.4);
    await waitFor(() => expect(audio.volume).toBeCloseTo(0.4));
    expect(audio.muted).toBe(false);
  });

  it('mutes at mount when the master gain is zero', async () => {
    const { audio } = await mountedAudio(0);
    await waitFor(() => expect(audio.muted).toBe(true));
  });

  it('calls load() exactly once after the element mounts', async () => {
    const { view } = await mountedAudio(1);
    await act(async () => {
      view.rerender(<FifthBellProgram masterGain={0.7} embedded />);
    });
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it('still follows later master-gain changes', async () => {
    const { view, audio } = await mountedAudio(1);
    await act(async () => {
      view.rerender(<FifthBellProgram masterGain={0.25} embedded />);
    });
    await waitFor(() => expect(audio.volume).toBeCloseTo(0.25));
  });
});
