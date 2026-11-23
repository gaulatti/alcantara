import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  fetchExternalSources,
  isSelectableLifecycle,
  type ExternalSource,
  type ExternalSourceLifecycle,
} from './externalSources';
import { authFetch } from './api';

vi.mock('./api', () => ({
  authFetch: vi.fn(),
}));

describe('externalSources service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isSelectableLifecycle', () => {
    it('returns true for previewable lifecycles: connected, degraded, reconnecting', () => {
      expect(isSelectableLifecycle('connected')).toBe(true);
      expect(isSelectableLifecycle('degraded')).toBe(true);
      expect(isSelectableLifecycle('reconnecting')).toBe(true);
    });

    it('returns false for non-previewable lifecycles: unconfigured, provisioning, waiting, offline, revoked', () => {
      const nonSelectable: ExternalSourceLifecycle[] = [
        'unconfigured',
        'provisioning',
        'waiting',
        'offline',
        'revoked',
      ];
      for (const lifecycle of nonSelectable) {
        expect(isSelectableLifecycle(lifecycle)).toBe(false);
      }
    });
  });

  describe('fetchExternalSources', () => {
    it('fetches external sources and returns json array on success', async () => {
      const mockSources: ExternalSource[] = [
        {
          id: 'src-1',
          name: 'Main Feed',
          transport: 'rtmp',
          lifecycle: 'connected',
          health: 'healthy',
          participantIdentity: 'source-main-feed',
          lastConnectedAt: '2026-11-14T12:00:00Z',
          revokedAt: null,
          programIds: ['prog-1'],
        },
      ];

      vi.mocked(authFetch).mockResolvedValueOnce(
        new Response(JSON.stringify(mockSources), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await fetchExternalSources();
      expect(authFetch).toHaveBeenCalledWith('/external-sources');
      expect(result).toEqual(mockSources);
    });

    it('throws parsed message on HTTP error', async () => {
      vi.mocked(authFetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Permission denied' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      await expect(fetchExternalSources()).rejects.toThrow('Permission denied');
    });

    it('throws generic error when error response is plain text', async () => {
      vi.mocked(authFetch).mockResolvedValueOnce(
        new Response('Service Unavailable', {
          status: 503,
          statusText: 'Service Unavailable',
        })
      );

      await expect(fetchExternalSources()).rejects.toThrow('Service Unavailable');
    });
  });
});

describe('isPreviewable', () => {
  it('requires a previewable lifecycle and a participant identity', async () => {
    const { isPreviewable } = await import('./externalSources');
    expect(isPreviewable({ lifecycle: 'connected', participantIdentity: 'p1' })).toBe(true);
    expect(isPreviewable({ lifecycle: 'connected', participantIdentity: null })).toBe(false);
    expect(isPreviewable({ lifecycle: 'offline', participantIdentity: 'p1' })).toBe(false);
  });
});
