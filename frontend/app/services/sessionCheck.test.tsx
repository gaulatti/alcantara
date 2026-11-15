import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAppSession } = vi.hoisted(() => ({ getAppSession: vi.fn() }));
vi.mock('./session', () => ({ getAppSession }));

import { checkAppSession } from './sessionCheck';

const session = { userSub: 'sub-1', token: 'token-1', payload: { email: 'a@example.test', name: 'Ada', picture: 'https://img.test/a.png' } };
const respond = (status: number, body: unknown = {}) =>
  vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: status >= 200 && status < 300, status, json: async () => body }));

describe('checkAppSession', () => {
  // Braces matter: a hook that returns a function has it run as cleanup, which would call the mock.
  beforeEach(() => {
    getAppSession.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is signed in when the provider has a session and the API accepts it', async () => {
    getAppSession.mockResolvedValue(session);
    const fetchMock = respond(200, { principalId: ' p-1 ' });
    vi.stubGlobal('fetch', fetchMock);
    await expect(checkAppSession(true)).resolves.toEqual({
      status: 'signed-in',
      user: { id: 'sub-1', principalId: 'p-1', email: 'a@example.test', name: 'Ada', picture: 'https://img.test/a.png' },
    });
    expect(getAppSession).toHaveBeenCalledWith(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/me');
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer token-1' });
  });

  it('is signed out when the provider has no session, without asking the API', async () => {
    getAppSession.mockResolvedValue({});
    const fetchMock = respond(200);
    vi.stubGlobal('fetch', fetchMock);
    await expect(checkAppSession()).resolves.toEqual({ status: 'signed-out' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403])('is unauthorized when the API answers %i', async (status) => {
    getAppSession.mockResolvedValue(session);
    vi.stubGlobal('fetch', respond(status));
    await expect(checkAppSession()).resolves.toEqual({ status: 'unauthorized' });
  });

  it.each([500, 502, 503, 504])('is unavailable, not signed out, when the API answers %i', async (status) => {
    getAppSession.mockResolvedValue(session);
    vi.stubGlobal('fetch', respond(status));
    await expect(checkAppSession()).resolves.toEqual({ status: 'unavailable' });
  });

  it('is unavailable when the API cannot be reached', async () => {
    getAppSession.mockResolvedValue(session);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await checkAppSession()).toEqual({ status: 'unavailable' });
  });

  it('is unavailable when the API answer cannot be read', async () => {
    getAppSession.mockResolvedValue(session);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } })));
    expect(await checkAppSession()).toEqual({ status: 'unavailable' });
  });

  it('is unavailable when the sign-in provider itself fails', async () => {
    getAppSession.mockRejectedValue(new Error('network'));
    const fetchMock = respond(200);
    vi.stubGlobal('fetch', fetchMock);
    expect(await checkAppSession()).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves the principal empty when the API gives none', async () => {
    getAppSession.mockResolvedValue({ userSub: 'sub-1', token: 't' });
    vi.stubGlobal('fetch', respond(200, { principalId: '  ' }));
    await expect(checkAppSession()).resolves.toMatchObject({ status: 'signed-in', user: { id: 'sub-1', principalId: null, email: '' } });
  });
});
