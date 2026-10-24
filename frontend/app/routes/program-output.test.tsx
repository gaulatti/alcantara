import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Program from './program';
import { getSceneTransitionPreset } from '../utils/sceneTransitions';

class RendererEvents {
  static instances: RendererEvents[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) { RendererEvents.instances.push(this); }
  emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
class RendererSocket extends EventTarget {
  static OPEN = 1;
  static instances: RendererSocket[] = [];
  readyState = 1;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; });
  constructor(readonly url: string) { super(); RendererSocket.instances.push(this); }
}
const scene = (id: number, text: string, componentType = 'lower-third') => ({
  id, name: text, layoutId: 1, chyronText: text,
  metadata: JSON.stringify({ [componentType]: { text } }),
  layout: { id: 1, name: 'Test layout', componentType, settings: '{}' },
});
const state = (version = 1, active = scene(1, 'On-air caption')) => ({
  programId: 'test-tv', version, activeSceneId: active.id, activeScene: active,
  stagedSceneId: 2, stagedScene: scene(2, 'Ready in Preview'), scenes: [], fadeToBlack: false,
});

let currentState: ReturnType<typeof state>;
let fetchMock: ReturnType<typeof vi.fn>;
async function mount(query = '') {
  const result = render(<MemoryRouter initialEntries={[`/program/test-tv${query}`]}>
    <Routes><Route path='/program/:id' element={<Program />} /></Routes>
  </MemoryRouter>);
  await act(async () => {});
  return result;
}
async function event(value: unknown) {
  await act(async () => { RendererEvents.instances.at(-1)!.emit(value); });
}

describe('Program output public state and SSE boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    currentState = state();
    RendererEvents.instances = [];
    RendererSocket.instances = [];
    vi.stubGlobal('EventSource', RendererEvents);
    vi.stubGlobal('WebSocket', RendererSocket);
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      const value = path.endsWith('/state') ? currentState
        : path.endsWith('/audio-bus') ? { version: 1, songSequence: null, mixerSettings: null }
        : path.endsWith('/broadcast-settings') ? { version: 1, id: 1 }
        : path.endsWith('/stingers') ? [] : null;
      return { ok: true, json: async () => value };
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('hydrates the actual Program renderer from scoped snapshots and opens scoped live transports', async () => {
    await mount();
    expect(screen.getByText('On-air caption')).toBeInTheDocument();
    expect(screen.queryByText('Ready in Preview')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/program/test-tv/state'));
    expect(RendererEvents.instances[0].url).toContain('/program/test-tv/events');
    expect(new URL(RendererSocket.instances[0].url).searchParams.get('role')).toBe('program');
    expect(new URL(RendererSocket.instances[0].url).searchParams.get('programId')).toBe('test-tv');
  });

  it('renders Preview confidence from staged state without opening an output WebSocket', async () => {
    const { container } = await mount('?confidence=preview');
    expect(screen.getByText('Ready in Preview')).toBeInTheDocument();
    expect(screen.queryByText('On-air caption')).not.toBeInTheDocument();
    expect(container.querySelector('[data-confidence-monitor]')).toHaveAttribute('data-confidence-monitor', 'preview');
    expect(RendererSocket.instances).toHaveLength(0);
    await event({ type: 'scene_staged', programId: 'other-tv', version: 2, stagedSceneId: 3, scene: scene(3, 'Other program') });
    expect(screen.queryByText('Other program')).not.toBeInTheDocument();
  });

  it('applies newer SSE state and prevents stale polling responses from restoring an old scene', async () => {
    await mount();
    await event({ type: 'program_state_snapshot', version: 4, state: state(4, scene(4, 'Current bulletin')) });
    expect(screen.getByText('Current bulletin')).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(5000));
    expect(screen.getByText('Current bulletin')).toBeInTheDocument();
    expect(screen.queryByText('On-air caption')).not.toBeInTheDocument();
    await event({ type: 'program_state_snapshot', version: 3, state: state(3, scene(3, 'Obsolete bulletin')) });
    expect(screen.queryByText('Obsolete bulletin')).not.toBeInTheDocument();
  });

  it('keeps Preview edits off Program until a cut and clears published scene output explicitly', async () => {
    await mount();
    await event({ type: 'scene_staged', programId: 'test-tv', version: 2, stagedSceneId: 3, scene: scene(3, 'Next bulletin') });
    expect(screen.queryByText('Next bulletin')).not.toBeInTheDocument();
    await event({ type: 'scene_change', version: 3, transitionId: 'cut', state: state(3, scene(3, 'Next bulletin')) });
    expect(screen.getByText('Next bulletin')).toBeInTheDocument();
    await event({ type: 'scene_cleared', version: 4 });
    expect(screen.getByText('No Active Scene')).toBeInTheDocument();
    expect(screen.queryByText('Next bulletin')).not.toBeInTheDocument();
  });

  it('updates the active scene in place but does not replace it with an unrelated scene edit', async () => {
    await mount();
    await event({ type: 'scene_update', version: 2, scene: scene(99, 'Unrelated edit') });
    expect(screen.getByText('On-air caption')).toBeInTheDocument();
    await event({ type: 'scene_update', version: 3, scene: scene(1, 'Corrected caption') });
    expect(screen.getByText('Corrected caption')).toBeInTheDocument();
  });

  it('composes persisted widget properties through the real multi-component renderer', async () => {
    const active = scene(1, '', 'header,ticker,chyron,clock-widget,qr-code,live-indicator,logo-widget,cronica-reiteramos');
    active.metadata = JSON.stringify({
      header: { title: 'Program headline', date: 'Editorial date' },
      ticker: { hashtag: '#Bulletin', url: 'news.example' },
      chyron: { text: 'Confirmed caption' },
      'clock-widget': { timezone: 'Europe/Rome' },
      'qr-code': { content: 'https://news.example/article?a=1&b=2' },
      'live-indicator': { animate: false },
      'logo-widget': { logoUrl: '/editorial-logo.svg' },
      'cronica-reiteramos': { text: 'Editorial update' },
    });
    currentState = state(1, active);
    const { container } = await mount();
    expect(screen.getByText('Program headline | Editorial date')).toBeInTheDocument();
    expect(screen.getByText('#Bulletin')).toBeInTheDocument();
    expect(screen.getByText('Confirmed caption')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Logo' })).toHaveAttribute('src', '/editorial-logo.svg');
    expect(new URL(screen.getByRole('img', { name: 'QR Code' }).getAttribute('src')!).searchParams.get('data')).toBe('https://news.example/article?a=1&b=2');
    expect(container.querySelector('.live-badge')).not.toHaveClass('animate');
  });

  it('keeps the renderer alive on malformed persisted scene metadata and accepts a later correction', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const active = scene(1, 'Ignored malformed text');
    active.metadata = 'not-json';
    currentState = state(1, active);
    await mount();
    expect(screen.getByText('Lower Third')).toBeInTheDocument();
    expect(console.error).toHaveBeenCalledWith('Failed to parse scene metadata:', expect.any(SyntaxError));
    await event({ type: 'scene_update', version: 2, scene: scene(1, 'Recovered caption') });
    expect(screen.getByText('Recovered caption')).toBeInTheDocument();
  });

  it.each(['crescendo-prism', 'velvet-eclipse', 'breaking-radar', 'anchor-desk', 'election-wall', 'market-pulse', 'world-desk', 'festival-runway', 'hit-parade'])(
    'takes the next scene at the %s preset cut point and removes the finished transition', async (transitionId) => {
      const { container } = await mount();
      const preset = getSceneTransitionPreset(transitionId);
      await event({ type: 'scene_change', version: 2, transitionId, state: state(2, scene(2, 'Next program scene')) });
      expect(container.querySelector('.scene-transition-overlay')).toHaveClass(`scene-transition-overlay--${transitionId}`);
      expect(screen.getByText('On-air caption')).toBeInTheDocument();
      await act(async () => vi.advanceTimersByTime(preset.cutPointMs - 1));
      expect(screen.queryByText('Next program scene')).not.toBeInTheDocument();
      await act(async () => vi.advanceTimersByTime(1));
      expect(screen.getByText('Next program scene')).toBeInTheDocument();
      await act(async () => vi.advanceTimersByTime(preset.durationMs - preset.cutPointMs));
      expect(container.querySelector('.scene-transition-overlay')).not.toBeInTheDocument();
    },
  );

  it.each(['full-screen', 'corner-bug'])('renders the persisted %s legacy layout through the real route', async (componentType) => {
    currentState = state(1, scene(1, `Persisted ${componentType}`, componentType));
    await mount();
    expect(screen.getByText(`Persisted ${componentType}`)).toBeInTheDocument();
  });

  it('preserves the exact fade-to-black state in Program confidence output', async () => {
    const { container } = await mount('?confidence=program');
    expect(container.querySelector('[data-confidence-fade-to-black]')).toHaveAttribute('data-confidence-fade-to-black', 'inactive');
    await event({ type: 'fade_to_black', version: 2, state: { ...state(2), fadeToBlack: true } });
    expect(container.querySelector('[data-confidence-fade-to-black]')).toHaveAttribute('data-confidence-fade-to-black', 'active');
    expect(container.querySelector('[data-confidence-fade-to-black]')).toHaveStyle({ opacity: '1' });
  });

  it('keeps a valid SSE scene visible when subsequent snapshot fetches fail', async () => {
    await mount();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('fixture network interruption'));
    await event({ type: 'program_state_snapshot', version: 2, state: state(2, scene(2, 'Live during reconnect')) });
    await act(async () => vi.advanceTimersByTime(5000));
    expect(screen.getByText('Live during reconnect')).toBeInTheDocument();
  });

  it('closes transports and timers when the output renderer unmounts', async () => {
    const { unmount } = await mount();
    const events = RendererEvents.instances[0];
    const socket = RendererSocket.instances[0];
    unmount();
    expect(events.close).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    const requests = fetchMock.mock.calls.length;
    await act(async () => vi.advanceTimersByTime(10000));
    expect(fetchMock).toHaveBeenCalledTimes(requests);
  });
});
