import type { AccessClient, AccessError, AccessGrant, AccessHistoryEntry, AccessRole, AccessToken } from './AccessPanel';

/**
 * Fictional data and an in-memory AccessClient for the Access panel's tests and
 * visual fixture. Nothing here talks to a network; every name, email and key is
 * made up.
 */

export const fixtureToken: AccessToken = {
  id: '6f0b0a52-0000-4000-8000-000000000001',
  name: 'Studio laptop',
  display_prefix: 'pmp_pat_abcd',
  permissions: ['alcantara:program:read', 'alcantara:flight:read'],
  created_at: '2026-11-19T10:00:00Z',
  expires_at: '2027-02-17T10:00:00Z',
  last_used_at: '2026-11-19T11:30:00Z',
  created_via_application: 'alcantara',
  last_used_application: 'monitor'
};
export const fixtureOldToken: AccessToken = {
  id: '6f0b0a52-0000-4000-8000-000000000002',
  name: 'Console script',
  display_prefix: 'pmp_pat_wxyz',
  permissions: ['alcantara:program:read'],
  created_at: '2026-10-01T08:00:00Z',
  expires_at: '',
  last_used_at: '',
  created_via_application: '',
  last_used_application: ''
};
export const fixtureRoles: AccessRole[] = [
  { id: 2, name: 'Operator', permissions: ['alcantara:access', 'alcantara:program:operate'] },
  { id: 3, name: 'Viewer', permissions: ['alcantara:access', 'alcantara:program:read'] }
];
export const fixtureGrants: AccessGrant[] = [
  { id: 9, user_id: 4, user_email: 'ana@example.test', role_id: 2, role_name: 'Operator', team_id: 0, granted_at: '2026-11-18T12:00:00Z' },
  { id: 10, user_id: 7, user_email: 'bruno@example.test', role_id: 3, role_name: 'Viewer', team_id: 0, granted_at: '2026-11-18T13:00:00Z' }
];
export const fixtureHistory: AccessHistoryEntry[] = [
  { at: '2026-11-19T12:00:00Z', action: 'grant', actor_email: 'ana@example.test', target: 'bruno@example.test: Viewer', via_application: 'alcantara', via_client: 'console' },
  { at: '2026-11-19T09:00:00Z', action: 'token_switch', actor_email: 'ana@example.test', target: 'on', via_application: 'alcantara', via_client: 'mcp' }
];
export const fixturePermissions = ['alcantara:access', 'alcantara:flight:read', 'alcantara:program:read'];

export const refusal = (error: AccessError['error'], status: number): AccessError => ({ status, error });

/** A client that answers from memory; `manager: false` refuses roles as Pompeii does. */
export function memoryAccessClient({ manager = true, unavailable = false }: { manager?: boolean; unavailable?: boolean } = {}): AccessClient {
  const gone = () => Promise.reject(refusal('access_unavailable', 503));
  let tokens = [fixtureToken, fixtureOldToken];
  let grants = [...fixtureGrants];
  let tokensOn = true;
  const managerOnly = <T>(value: () => T): Promise<T> => (manager ? Promise.resolve(value()) : Promise.reject(refusal('forbidden', 403)));
  if (unavailable)
    return { listMyTokens: gone, createMyToken: gone, revokeMyToken: gone, getTokenSwitch: gone, setTokenSwitch: gone, listRoles: gone, listGrants: gone, grant: gone, revokeGrant: gone, listHistory: gone };
  return {
    listMyTokens: () => Promise.resolve(tokens),
    createMyToken: (input) => {
      if (!tokensOn) return Promise.reject(refusal('tokens_off', 409));
      const token: AccessToken = { ...fixtureToken, id: `new-${tokens.length}`, name: input.name, permissions: input.permissions ?? fixturePermissions, last_used_at: '', last_used_application: '', expires_at: '' };
      tokens = [...tokens, token];
      return Promise.resolve({ token, value: 'pmp_pat_FICTIONAL_VALUE_SHOWN_ONCE' });
    },
    revokeMyToken: (id) => {
      tokens = tokens.filter((token) => token.id !== id);
      return Promise.resolve();
    },
    getTokenSwitch: () => managerOnly(() => tokensOn),
    setTokenSwitch: (enabled) => {
      tokensOn = enabled;
      return Promise.resolve(enabled);
    },
    listRoles: () => managerOnly(() => fixtureRoles),
    listGrants: () => managerOnly(() => grants),
    grant: (input) => {
      const role = fixtureRoles.find((candidate) => candidate.id === input.role_id);
      const added: AccessGrant = { id: 100 + grants.length, user_id: input.user_id, user_email: '', role_id: input.role_id, role_name: role?.name ?? '', team_id: 0, granted_at: '2026-11-19T14:00:00Z' };
      grants = [...grants, added];
      return Promise.resolve(added);
    },
    revokeGrant: (id) => {
      grants = grants.filter((grant) => grant.id !== id);
      return Promise.resolve();
    },
    listHistory: () => Promise.resolve(fixtureHistory),
    listMyPermissions: () => Promise.resolve(fixturePermissions)
  };
}
