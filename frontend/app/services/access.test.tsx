import { expect, it, vi } from 'vitest';
import { createAccessClient } from './access';
import { fixtureGrants, fixtureHistory, fixtureOldToken, fixtureRoles, fixtureToken } from '../components/access/accessFixtures';

// The fetch-based AccessClient: the routes it calls, what it sends, and how a
// refusal becomes the contract's AccessError (never Pompeii's words).

function client(handler: (path: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return handler(path, init);
  });
  return { access: createAccessClient(fetcher as never), calls };
}

it('calls each /access route with the method and body of the contract', async () => {
  const { access, calls } = client((path, init) => {
    const key = `${init?.method ?? 'GET'} ${path.split('?')[0]}`;
    const answers: Record<string, unknown> = {
      'GET /access/tokens': { tokens: [fixtureToken] },
      'POST /access/tokens': { token: fixtureOldToken, value: 'pmp_pat_FICTIONAL' },
      'DELETE /access/tokens/a%2Fb': {},
      'GET /access/token-switch': { enabled: true },
      'PUT /access/token-switch': { enabled: false },
      'GET /access/roles': { roles: fixtureRoles },
      'GET /access/grants': { grants: fixtureGrants },
      'POST /access/grants': fixtureGrants[0],
      'DELETE /access/grants/9': {},
      'GET /access/history': { entries: fixtureHistory },
      'GET /access/my-permissions': { permissions: ['alcantara:access'] }
    };
    return Response.json(answers[key] ?? { missing: key });
  });
  expect(await access.listMyTokens()).toEqual([fixtureToken]);
  expect(await access.createMyToken({ name: 'x', all_held_in_application: true })).toEqual({ token: fixtureOldToken, value: 'pmp_pat_FICTIONAL' });
  await access.revokeMyToken('a/b');
  expect(await access.getTokenSwitch()).toBe(true);
  expect(await access.setTokenSwitch(false)).toBe(false);
  expect(await access.listRoles()).toEqual(fixtureRoles);
  expect(await access.listGrants()).toEqual(fixtureGrants);
  expect(await access.grant({ user_id: 4, role_id: 2 })).toEqual(fixtureGrants[0]);
  await access.revokeGrant(9);
  expect(await access.listHistory()).toEqual(fixtureHistory);
  expect(await access.listHistory({ limit: 20, before: '2026-11-19T12:00:00Z' })).toEqual(fixtureHistory);
  expect(await access.listMyPermissions!()).toEqual(['alcantara:access']);
  expect(calls.map((call) => `${call.init?.method ?? 'GET'} ${call.path}`)).toEqual([
    'GET /access/tokens',
    'POST /access/tokens',
    'DELETE /access/tokens/a%2Fb',
    'GET /access/token-switch',
    'PUT /access/token-switch',
    'GET /access/roles',
    'GET /access/grants',
    'POST /access/grants',
    'DELETE /access/grants/9',
    'GET /access/history',
    'GET /access/history?limit=20&before=2026-11-19T12%3A00%3A00Z',
    'GET /access/my-permissions'
  ]);
  expect(JSON.parse(calls[1].init!.body as string)).toEqual({ name: 'x', all_held_in_application: true });
  expect(calls[1].init!.headers).toEqual({ 'Content-Type': 'application/json' });
  expect(calls[0].init!.headers).toEqual({});
  expect(JSON.parse(calls[4].init!.body as string)).toEqual({ enabled: false });
  expect(JSON.parse(calls[7].init!.body as string)).toEqual({ user_id: 4, role_id: 2 });
});

it.each([
  [401, { error: 'unauthenticated' }, 'unauthenticated'],
  [403, { error: 'forbidden' }, 'forbidden'],
  [400, { error: 'invalid_request' }, 'invalid_request'],
  [409, { error: 'tokens_off' }, 'tokens_off'],
  [404, { error: 'not_found' }, 'not_found'],
  [503, { error: 'access_unavailable' }, 'access_unavailable'],
  // The guard's own words, and bodies with none, are read by status.
  [401, { error: 'UNAUTHENTICATED', reason: 'DENY_UNSUPPORTED_CREDENTIAL' }, 'unauthenticated'],
  [403, { error: 'FORBIDDEN' }, 'forbidden'],
  [409, null, 'tokens_off'],
  [400, null, 'invalid_request'],
  [404, null, 'not_found'],
  [500, null, 'access_unavailable'],
  [502, { error: 'Bad gateway' }, 'access_unavailable']
])('rejects %s %j as %s with the status kept', async (status, body, error) => {
  const { access } = client(() => (body === null ? new Response('<html>nope</html>', { status }) : Response.json(body, { status })));
  await expect(access.listMyTokens()).rejects.toEqual({ status, error });
});

it('rejects a request that never reached the backend as not available yet', async () => {
  const access = createAccessClient((() => Promise.reject(new TypeError('network down'))) as never);
  await expect(access.listRoles()).rejects.toEqual({ status: 503, error: 'access_unavailable' });
});

it('reads an empty answer to a change as success', async () => {
  const { access } = client(() => new Response(null, { status: 204 }));
  await expect(access.revokeMyToken('x')).resolves.toBeUndefined();
});

it('uses the app session fetch by default', () => {
  expect(typeof createAccessClient().listMyTokens).toBe('function');
});
