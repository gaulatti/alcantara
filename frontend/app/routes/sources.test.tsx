import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import SourcesRoute, { meta } from './sources';
import { authFetch } from '../services/api';
import type {
  ExternalSource,
  ExternalSourceHealth,
  ExternalSourceLifecycle,
} from '../services/externalSources';

vi.mock('../services/api', () => ({
  authFetch: vi.fn(),
}));

vi.mock('../utils/globalProgram', () => ({
  useGlobalProgramId: () => ['main', vi.fn()],
}));

class MockTrackPub {
  isSubscribed = false;
  setSubscribed = vi.fn((sub: boolean) => {
    this.isSubscribed = sub;
  });
  track = {
    kind: 'video',
    attach: vi.fn(),
    detach: vi.fn(),
  };
}

class MockParticipant {
  trackPublications = new Map<string, MockTrackPub>();
  constructor(public identity: string) {}
  addTrack(kind: 'video' | 'audio') {
    const pub = new MockTrackPub();
    (pub.track as any).kind = kind;
    this.trackPublications.set(`${this.identity}-${kind}`, pub);
    return pub;
  }
}

class MockRoom {
  remoteParticipants = new Map<string, MockParticipant>();
  private handlers = new Map<string, Function[]>();

  on(event: string, fn: Function) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(fn);
  }
  off(event: string, fn: Function) {
    const arr = this.handlers.get(event) || [];
    this.handlers.set(event, arr.filter((f) => f !== fn));
  }
  emit(event: string, ...args: any[]) {
    for (const fn of this.handlers.get(event) || []) {
      fn(...args);
    }
  }
  connect = vi.fn();
  disconnect = vi.fn();
}

describe('SourcesRoute (/sources)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the list from GET /external-sources for the current program covering all eight lifecycles and all four health values', async () => {
    const lifecycles: ExternalSourceLifecycle[] = [
      'unconfigured',
      'provisioning',
      'waiting',
      'connected',
      'degraded',
      'reconnecting',
      'offline',
      'revoked',
    ];

    const healths: ExternalSourceHealth[] = [
      'unknown',
      'healthy',
      'degraded',
      'unavailable',
    ];

    const mockSources: ExternalSource[] = lifecycles.map((lc, index) => ({
      id: `src-${lc}`,
      name: `Source ${lc.toUpperCase()}`,
      transport: 'rtmp',
      lifecycle: lc,
      health: healths[index % healths.length],
      participantIdentity: `part-${lc}`,
      lastConnectedAt: null,
      revokedAt: null,
      programIds: ['main'],
    }));

    // Add one source belonging to a different program to verify filtering
    mockSources.push({
      id: 'src-other-prog',
      name: 'Other Program Source',
      transport: 'srt',
      lifecycle: 'connected',
      health: 'healthy',
      participantIdentity: 'other-part',
      lastConnectedAt: null,
      revokedAt: null,
      programIds: ['secondary'],
    });

    vi.mocked(authFetch).mockResolvedValueOnce(
      new Response(JSON.stringify(mockSources), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    render(<SourcesRoute />);

    await waitFor(() => {
      expect(screen.getByText('External Sources')).toBeInTheDocument();
    });

    // Check all eight lifecycles are rendered
    for (const lc of lifecycles) {
      expect(screen.getByTestId(`source-lifecycle-src-${lc}`)).toHaveTextContent(lc);
    }

    // Check all four health values are rendered
    for (const h of healths) {
      const match = screen.getAllByTestId(/source-health-/).find((el) =>
        el.textContent?.toLowerCase().includes(h)
      );
      expect(match).toBeDefined();
    }

    // Check that other program source is not listed
    expect(screen.queryByText('Other Program Source')).not.toBeInTheDocument();
  });

  it('subscribes to selected source participant and deselecting unsubscribes', async () => {
    const mockSource: ExternalSource = {
      id: 'src-select-1',
      name: 'Mobile Feed',
      transport: 'whip',
      lifecycle: 'connected',
      health: 'healthy',
      participantIdentity: 'mobile-feed-part',
      lastConnectedAt: null,
      revokedAt: null,
      programIds: ['main'],
    };

    const room = new MockRoom();
    const p = new MockParticipant('mobile-feed-part');
    const vTrackPub = p.addTrack('video');
    const aTrackPub = p.addTrack('audio');
    room.remoteParticipants.set('mobile-feed-part', p);

    render(<SourcesRoute initialSources={[mockSource]} room={room} />);

    // Initially unselected - nothing subscribed
    expect(vTrackPub.setSubscribed).not.toHaveBeenCalled();
    expect(aTrackPub.setSubscribed).not.toHaveBeenCalled();

    // Click preview button to select
    const previewBtn = screen.getByRole('button', { name: 'Preview Mobile Feed' });
    fireEvent.click(previewBtn);

    // Selected -> Track publications subscribed
    expect(vTrackPub.setSubscribed).toHaveBeenCalledWith(true);
    expect(aTrackPub.setSubscribed).toHaveBeenCalledWith(true);

    // Preview tile appears
    expect(screen.getByTestId('preview-tile-src-select-1')).toBeInTheDocument();

    // Deselect from tile close button
    const deselectBtn = screen.getByRole('button', { name: 'Deselect Mobile Feed' });
    fireEvent.click(deselectBtn);

    // Deselected -> Track publications unsubscribed
    expect(vTrackPub.setSubscribed).toHaveBeenCalledWith(false);
    expect(aTrackPub.setSubscribed).toHaveBeenCalledWith(false);
  });

  it('contains no controls that change Program (CUT, TAKE, STAGE)', () => {
    const mockSource: ExternalSource = {
      id: 'src-safe',
      name: 'Safe Source',
      transport: 'rtmp',
      lifecycle: 'connected',
      health: 'healthy',
      participantIdentity: 'safe-source',
      lastConnectedAt: null,
      revokedAt: null,
      programIds: ['main'],
    };

    render(<SourcesRoute initialSources={[mockSource]} />);

    expect(screen.queryByText(/^cut$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^take$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^stage$/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cut/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /take/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /stage/i })).not.toBeInTheDocument();
  });

  it('shows loading, then an error state whose retry loads the list', async () => {
    vi.mocked(authFetch).mockRejectedValueOnce(new Error('Network down'));
    render(<SourcesRoute />);
    expect(screen.getByTestId('source-list-loading')).toBeInTheDocument();
    expect(await screen.findByText('External sources could not be loaded')).toBeInTheDocument();
    vi.mocked(authFetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: 'src-retry',
            name: 'Retried Source',
            transport: 'rtmp',
            lifecycle: 'connected',
            health: 'healthy',
            participantIdentity: 'retry-part',
            lastConnectedAt: null,
            revokedAt: null,
            programIds: ['main'],
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading sources' }));
    expect(await screen.findByText('Retried Source')).toBeInTheDocument();
  });
});


// gaulatti/alcantara#404 (sources route, outside the #404 list): the page's browser title.
describe('SourcesRoute meta', () => {
  it('names the page for the browser', () => {
    expect(meta()).toEqual([{ title: 'External Sources - Alcántara' }]);
  });
});
