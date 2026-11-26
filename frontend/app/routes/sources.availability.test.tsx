import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import SourcesRoute from './sources';
import { authFetch } from '../services/api';
import type { ExternalSource } from '../services/externalSources';

const connectMock = vi.hoisted(() => vi.fn());
const disconnectMock = vi.hoisted(() => vi.fn());

vi.mock('livekit-client', () => ({
  Room: class {
    connect = connectMock;
    disconnect = disconnectMock;
    on = vi.fn();
    off = vi.fn();
    remoteParticipants = new Map();
  },
  RoomEvent: {},
}));

vi.mock('../services/api', () => ({ authFetch: vi.fn() }));
vi.mock('../utils/globalProgram', () => ({ useGlobalProgramId: () => ['main', vi.fn()] }));

const source: ExternalSource = {
  id: 's1',
  name: 'Camera One',
  transport: 'whip',
  lifecycle: 'connected',
  health: 'healthy',
  participantIdentity: 'cam-1',
  lastConnectedAt: null,
  revokedAt: null,
  programIds: ['main'],
};

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => '' } as Response;
}

function stub(config: Response, token?: Response) {
  vi.stubGlobal('fetch', vi.fn(async () => config));
  vi.mocked(authFetch).mockResolvedValue(token ?? json({ serverUrl: 'wss://x', token: 't' }));
}

async function renderPage() {
  render(<SourcesRoute initialSources={[source]} />);
  return screen.findByRole('button', { name: /Preview Camera One/ });
}

describe('SourcesRoute preview availability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function expectBlocked(message: string) {
    const button = await renderPage();
    await waitFor(() => expect(screen.getByTestId('preview-availability')).toHaveTextContent(message));
    expect(button).toBeDisabled();
    const reason = button.getAttribute('aria-describedby');
    expect(reason).toBeTruthy();
    expect(document.getElementById(reason!)).toHaveTextContent(message);
  }

  it('is ready and enabled after a successful connect', async () => {
    stub(json({ livekit: { enabled: true } }));
    const button = await renderPage();
    await waitFor(() => expect(screen.queryByTestId('preview-availability')).toBeNull());
    expect(button).toBeEnabled();
    expect(connectMock).toHaveBeenCalledWith('wss://x', 't', { autoSubscribe: false });
  });

  it('says connecting and disables preview until connected', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const button = await renderPage();
    expect(screen.getByTestId('preview-availability')).toHaveTextContent('Connecting live preview');
    expect(button).toBeDisabled();
  });

  it('reports unconfigured when /webrtc/config is not ok', async () => {
    stub(json({}, 500));
    await expectBlocked('the media service is not configured on this server');
  });

  it('reports unconfigured when livekit is not enabled', async () => {
    stub(json({ livekit: { enabled: false } }));
    await expectBlocked('the media service is not configured on this server');
  });

  it('reports denied for a 403 operator token', async () => {
    stub(json({ livekit: { enabled: true } }), json({}, 403));
    await expectBlocked("You don't have permission to preview sources.");
  });

  it('reports denied for a 401 operator token', async () => {
    stub(json({ livekit: { enabled: true } }), json({}, 401));
    await expectBlocked("You don't have permission to preview sources.");
  });

  it('reports failed for another token error', async () => {
    stub(json({ livekit: { enabled: true } }), json({}, 502));
    await expectBlocked('Live preview could not connect.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('reports failed when the token body is malformed', async () => {
    stub(json({ livekit: { enabled: true } }), {
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('bad json');
      },
    } as unknown as Response);
    await expectBlocked('Live preview could not connect.');
  });

  it('reports failed when Room.connect throws, and Retry reconnects', async () => {
    stub(json({ livekit: { enabled: true } }));
    connectMock.mockRejectedValueOnce(new Error('boom'));
    const button = await renderPage();
    await waitFor(() => expect(screen.getByTestId('preview-availability')).toHaveTextContent('could not connect'));
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByTestId('preview-availability')).toBeNull());
    expect(button).toBeEnabled();
  });

  it('offers no Retry for unconfigured or denied', async () => {
    stub(json({ livekit: { enabled: false } }));
    await renderPage();
    await waitFor(() => expect(screen.getByTestId('preview-availability')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
  it('deselects a previewed source when its preview button is pressed again', async () => {
    stub(json({ livekit: { enabled: true } }));
    const button = await renderPage();
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    const stop = await screen.findByRole('button', { name: 'Stop previewing Camera One' });
    expect(stop).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(stop);
    expect(await screen.findByRole('button', { name: 'Preview Camera One' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('disconnects a room whose connect finishes after the page was left', async () => {
    stub(json({ livekit: { enabled: true } }));
    let finish: () => void = () => {};
    connectMock.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    const { unmount } = render(<SourcesRoute initialSources={[source]} />);
    await waitFor(() => expect(connectMock).toHaveBeenCalled());
    unmount();
    // Leaving the page disconnects the room that was being created...
    expect(disconnectMock).toHaveBeenCalledTimes(1);
    finish();
    // ...and the late connect disconnects it again instead of publishing a stale room.
    await waitFor(() => expect(disconnectMock).toHaveBeenCalledTimes(2));
  });

  it('refreshes the list every ten seconds and stops when the page is left', async () => {
    stub(json({ livekit: { enabled: true } }));
    vi.mocked(authFetch).mockImplementation(async (path: string) =>
      path === '/external-sources' ? json([source]) : json({ serverUrl: 'wss://x', token: 't' })
    );
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { unmount } = render(<SourcesRoute initialSources={[source]} />);
      const listCalls = () =>
        vi.mocked(authFetch).mock.calls.filter(([path]) => path === '/external-sources').length;
      expect(listCalls()).toBe(0);
      await vi.advanceTimersByTimeAsync(10000);
      expect(listCalls()).toBe(1);
      unmount();
      await vi.advanceTimersByTimeAsync(20000);
      expect(listCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
  // gaulatti/alcantara#527 (sources route, untriaged gaps): leaving the page while the operator token is still on its way
  // must not open a room for a page that has gone.
  it('does not open a preview room when the page is left while its token is pending', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ livekit: { enabled: true } })));
    let release!: (value: Response) => void;
    vi.mocked(authFetch).mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
    const view = render(<SourcesRoute initialSources={[source]} />);
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    view.unmount();
    release(json({ serverUrl: 'wss://x', token: 't' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connectMock).not.toHaveBeenCalled();
  });
});

describe('SourcesRoute preview check left before it answers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // A check that answers after the page is gone must not set state on it: each answer is refused or accepted silently.
  async function leaveBeforeAnswer(answer: Response) {
    let respond: (response: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; })));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { unmount } = render(<SourcesRoute initialSources={[source]} />);
    unmount();
    respond(answer);
    await new Promise((done) => setTimeout(done, 0));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  }

  it('ignores a config answer that is refused after the page is left', async () => {
    await leaveBeforeAnswer(json({}, 500));
  });

  it('ignores a config answer that has LiveKit disabled after the page is left', async () => {
    await leaveBeforeAnswer(json({ livekit: { enabled: false } }));
  });
});
