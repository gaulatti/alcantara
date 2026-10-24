import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const account = vi.hoisted(() => ({ fetchAuthSession: vi.fn(), signOut: vi.fn() }));
vi.mock('aws-amplify/auth', () => account);

const storageKey = 'alcantara.testAuth.session';
const now = Date.parse('2026-10-24T12:00:00Z');
const validExpiry = '2026-10-24T12:05:00Z';

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  window.sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

function localSessionRequest() {
  const request = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
    accessToken: 'fresh-local-token', expiresAt: validExpiry,
    user: { sub: 'operator-a', name: 'Fictional operator', email: 'operator@example.invalid' },
  })));
  vi.stubGlobal('fetch', request);
  vi.stubEnv('VITE_AUTH_MODE', 'test');
  vi.stubEnv('VITE_API_BASE_URL', 'http://local-api.example/');
  return request;
}

describe('local test session lifecycle', () => {
  it('never reuses a stored credential with an unparseable expiry', async () => {
    const request = localSessionRequest();
    window.sessionStorage.setItem(storageKey, JSON.stringify({ token: 'stale', userSub: 'operator-a', expiresAt: 'invalid' }));
    const { getAppSession } = await import('./session');
    await expect(getAppSession()).resolves.toMatchObject({ token: 'fresh-local-token' });
    expect(request).toHaveBeenCalledOnce();
  });

  it('reuses a valid stored credential without issuing a network request', async () => {
    const request = localSessionRequest();
    const stored = { token: 'stored-token', userSub: 'operator-a', expiresAt: validExpiry };
    window.sessionStorage.setItem(storageKey, JSON.stringify(stored));
    const { getAppSession } = await import('./session');
    await expect(getAppSession()).resolves.toEqual(stored);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    'not JSON', 'null', '{}',
    JSON.stringify({ token: 'old', userSub: 'operator-a' }),
    JSON.stringify({ userSub: 'operator-a', expiresAt: validExpiry }),
    JSON.stringify({ token: 'old', expiresAt: validExpiry }),
    JSON.stringify({ token: 'old', userSub: 'operator-a', expiresAt: '2026-10-24T11:59:00Z' }),
    JSON.stringify({ token: 'old', userSub: 'operator-a', expiresAt: '2026-10-24T12:00:30Z' }),
  ])('refreshes invalid or expiring stored credentials %s', async (stored) => {
    const request = localSessionRequest();
    window.sessionStorage.setItem(storageKey, stored);
    const { getAppSession } = await import('./session');
    await expect(getAppSession()).resolves.toMatchObject({ userSub: 'operator-a', token: 'fresh-local-token' });
    expect(request).toHaveBeenCalledOnce();
  });

  it('deduplicates concurrent issuance, persists the result, and explicitly refreshes when requested', async () => {
    const request = localSessionRequest();
    vi.stubEnv('VITE_TEST_AUTH_IDENTITY', 'operator b');
    const { getAppSession } = await import('./session');
    const [first, second] = await Promise.all([getAppSession(), getAppSession()]);
    expect(first).toEqual(second);
    expect(request).toHaveBeenCalledWith('http://local-api.example/__test/session?identity=operator%20b');
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(window.sessionStorage.getItem(storageKey)!)).toMatchObject({ token: 'fresh-local-token', expiresAt: validExpiry });
    await getAppSession(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('fails closed on a rejected issuance and retries only after explicit refresh', async () => {
    const request = localSessionRequest();
    request.mockResolvedValueOnce(new Response('denied', { status: 403 }));
    const { getAppSession } = await import('./session');
    await expect(getAppSession()).rejects.toThrow('Test session failed (403)');
    await expect(getAppSession()).rejects.toThrow('Test session failed (403)');
    expect(request).toHaveBeenCalledTimes(1);
    await expect(getAppSession(true)).resolves.toMatchObject({ token: 'fresh-local-token' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('clears the local credential and cached issuance without calling Cognito', async () => {
    const request = localSessionRequest();
    const { getAppSession, clearAppSession } = await import('./session');
    await getAppSession();
    await clearAppSession();
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    expect(account.signOut).not.toHaveBeenCalled();
    await getAppSession();
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('authenticated account session lifecycle', () => {
  it('uses the normal account store and preserves the requested refresh flag', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'cognito');
    account.fetchAuthSession.mockResolvedValue({
      userSub: 'native-sub', tokens: { idToken: { toString: () => 'native-token', payload: { sub: 'native-sub' } } },
    });
    const { getAppSession, isTestAuth } = await import('./session');
    expect(isTestAuth()).toBe(false);
    await expect(getAppSession(true)).resolves.toEqual({ userSub: 'native-sub', token: 'native-token', payload: { sub: 'native-sub' } });
    expect(account.fetchAuthSession).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it('represents an absent account token without manufacturing authorization', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'cognito');
    account.fetchAuthSession.mockResolvedValue({});
    const { getAppSession, clearAppSession } = await import('./session');
    await expect(getAppSession()).resolves.toEqual({ userSub: undefined, token: undefined, payload: undefined });
    expect(account.fetchAuthSession).toHaveBeenCalledWith({ forceRefresh: false });
    await clearAppSession();
    expect(account.signOut).toHaveBeenCalledOnce();
  });

  it('propagates an account-provider failure', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'cognito');
    account.fetchAuthSession.mockRejectedValue(new Error('account unavailable'));
    const { getAppSession } = await import('./session');
    await expect(getAppSession()).rejects.toThrow('account unavailable');
  });
});
