import type { AccessClient, AccessError, AccessGrant, AccessHistoryEntry, AccessRole, AccessToken } from '../components/access/AccessPanel';
import { authFetch } from './api';

/**
 * gaulatti/alcantara#224: the AccessClient over Alcantara's own /access
 * routes. A refusal rejects with an AccessError built from the status and the
 * contract's error code; Pompeii's own wording never arrives here, and the
 * body of a token answer is read only into the result, never logged.
 */

const KNOWN: ReadonlySet<string> = new Set(['unauthenticated', 'forbidden', 'invalid_request', 'tokens_off', 'not_found', 'access_unavailable']);

/** The guard's own 401 and 403 carry other words, so the status decides then. */
function errorFor(status: number, code: unknown): AccessError {
  if (typeof code === 'string' && KNOWN.has(code)) return { status, error: code as AccessError['error'] };
  const byStatus: Record<number, AccessError['error']> = { 400: 'invalid_request', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 409: 'tokens_off' };
  return { status, error: byStatus[status] ?? 'access_unavailable' };
}

export function createAccessClient(fetcher: typeof authFetch = authFetch): AccessClient {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(path, {
        ...init,
        headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}) }
      });
    } catch {
      throw { status: 503, error: 'access_unavailable' } satisfies AccessError;
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) throw errorFor(response.status, body?.error);
    return body as T;
  }
  const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

  return {
    listMyTokens: async () => (await call<{ tokens: AccessToken[] }>('/access/tokens')).tokens,
    createMyToken: (input) => call('/access/tokens', json('POST', input)),
    revokeMyToken: async (id) => {
      await call(`/access/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    getTokenSwitch: async () => (await call<{ enabled: boolean }>('/access/token-switch')).enabled,
    setTokenSwitch: async (enabled) => (await call<{ enabled: boolean }>('/access/token-switch', json('PUT', { enabled }))).enabled,
    listRoles: async () => (await call<{ roles: AccessRole[] }>('/access/roles')).roles,
    listGrants: async () => (await call<{ grants: AccessGrant[] }>('/access/grants')).grants,
    grant: (input) => call<AccessGrant>('/access/grants', json('POST', input)),
    revokeGrant: async (id) => {
      await call(`/access/grants/${id}`, { method: 'DELETE' });
    },
    listHistory: async (input = {}) => {
      const query = new URLSearchParams();
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      if (input.before) query.set('before', input.before);
      const suffix = query.size > 0 ? `?${query}` : '';
      return (await call<{ entries: AccessHistoryEntry[] }>(`/access/history${suffix}`)).entries;
    },
    listMyPermissions: async () => (await call<{ permissions: string[] }>('/access/my-permissions')).permissions
  };
}
