import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
  vi.resetModules();
});

async function install(base = 'https://api.example/api') {
  const nativeFetch = vi.fn().mockImplementation(async () => new Response('{}'));
  const getAppSession = vi.fn().mockResolvedValue({ token: 'initial-token' });
  const reportInvalidSession = vi.fn();
  vi.stubGlobal('fetch', nativeFetch);
  vi.doMock('../utils/apiBaseUrl', () => ({ getApiBaseUrl: () => base }));
  vi.doMock('./session', () => ({ getAppSession }));
  vi.doMock('./session-events', () => ({ reportInvalidSession }));
  const module = await import('./authenticatedFetch');
  module.installAuthenticatedFetch();
  return { ...module, nativeFetch, getAppSession, reportInvalidSession };
}

describe('authenticated fetch origin and retry boundaries', () => {
  it('authenticates only the configured origin and API path boundary', async () => {
    const f = await install();
    await fetch(new URL('https://api.example/api/program'));
    await fetch('https://api.example/api');
    await fetch('https://api.example/api-extra/program');
    await fetch('https://media.example/api/program');
    expect(f.getAppSession).toHaveBeenCalledTimes(2);
    const headers = f.nativeFetch.mock.calls.map((call) => call[1]?.headers && new Headers(call[1].headers).get('Authorization'));
    expect(headers).toEqual(['Bearer initial-token', 'Bearer initial-token', undefined, undefined]);
  });
  it('retries one exact Request with refreshed credentials while retaining body and caller headers', async () => {
    const f = await install();
    f.getAppSession.mockResolvedValueOnce({ token: 'old' }).mockResolvedValueOnce({ token: 'new' });
    f.nativeFetch.mockResolvedValueOnce(new Response('expired', { status: 401 })).mockResolvedValueOnce(new Response('accepted'));
    const input = new Request('https://api.example/api/program', { method: 'POST', headers: { 'X-Trace': 'attempt-1' }, body: 'command' });
    await expect(fetch(input)).resolves.toHaveProperty('status', 200);
    expect(f.getAppSession.mock.calls).toEqual([[false], [true]]);
    expect(f.nativeFetch).toHaveBeenCalledTimes(2);
    for (const [request, init] of f.nativeFetch.mock.calls) {
      expect(request).not.toBe(input);
      expect(await request.text()).toBe('command');
      expect(new Headers(init.headers).get('X-Trace')).toBe('attempt-1');
    }
    expect(new Headers(f.nativeFetch.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer old');
    expect(new Headers(f.nativeFetch.mock.calls[1][1].headers).get('Authorization')).toBe('Bearer new');
    expect(f.reportInvalidSession).not.toHaveBeenCalled();
    expect(await input.text()).toBe('command');
  });
  it('invalidates a session after a second unauthorized response without further retries', async () => {
    const f = await install();
    f.nativeFetch.mockImplementation(async () => new Response('denied', { status: 401 }));
    await expect(fetch('https://api.example/api/program')).resolves.toHaveProperty('status', 401);
    expect(f.nativeFetch).toHaveBeenCalledTimes(2);
    expect(f.reportInvalidSession).toHaveBeenCalledOnce();
  });
  it('preserves the original unauthorized response when refresh becomes unavailable', async () => {
    const f = await install();
    const denied = new Response('denied', { status: 401 });
    f.nativeFetch.mockResolvedValueOnce(denied);
    f.getAppSession.mockResolvedValueOnce({ token: 'old' }).mockRejectedValueOnce(new Error('account unavailable'));
    await expect(fetch('https://api.example/api/program')).resolves.toBe(denied);
    expect(f.nativeFetch).toHaveBeenCalledOnce();
    expect(f.reportInvalidSession).toHaveBeenCalledOnce();
  });
  it('reports a missing account session and leaves public server authorization authoritative', async () => {
    const f = await install();
    f.getAppSession.mockRejectedValue(new Error('no account'));
    const init = { method: 'GET', headers: { 'X-Trace': 'public-attempt' } };
    await fetch('https://api.example/api/public', init);
    expect(f.reportInvalidSession).toHaveBeenCalledOnce();
    expect(f.nativeFetch).toHaveBeenCalledWith('https://api.example/api/public', init);
  });
  it('rejects an empty ID token before transport and propagates non-session network failure', async () => {
    const f = await install();
    f.getAppSession.mockResolvedValueOnce({});
    await expect(fetch('https://api.example/api/program')).rejects.toThrow('Authenticated session has no ID token');
    expect(f.nativeFetch).not.toHaveBeenCalled();
    f.nativeFetch.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(fetch('https://api.example/api/program')).rejects.toThrow('network unavailable');
  });
  it('returns the initial unauthorized response if refresh has no token', async () => {
    const f = await install();
    const denied = new Response('denied', { status: 401 });
    f.nativeFetch.mockResolvedValueOnce(denied);
    f.getAppSession.mockResolvedValueOnce({ token: 'old' }).mockResolvedValueOnce({});
    await expect(fetch('https://api.example/api/program')).resolves.toBe(denied);
    expect(f.reportInvalidSession).not.toHaveBeenCalled();
  });
  it('installs once and recognizes only a single public Program renderer segment', async () => {
    const f = await install('https://api.example');
    const installed = globalThis.fetch;
    f.installAuthenticatedFetch();
    expect(globalThis.fetch).toBe(installed);
    expect(f.isPublicProgramRendererPath('/program/main')).toBe(true);
    expect(f.isPublicProgramRendererPath('/program/main/')).toBe(true);
    expect(f.isPublicProgramRendererPath('/program/main/control')).toBe(false);
    expect(f.isPublicProgramRendererPath('/program/')).toBe(false);
    await fetch('https://api.example/program');
    expect(f.getAppSession).toHaveBeenCalledOnce();
  });
  it('does not install a browser hook during server rendering', async () => {
    const originalWindow = window;
    const f = await install();
    vi.resetModules();
    vi.stubGlobal('window', undefined);
    const serverModule = await import('./authenticatedFetch');
    const current = globalThis.fetch;
    serverModule.installAuthenticatedFetch();
    expect(globalThis.fetch).toBe(current);
    vi.stubGlobal('window', originalWindow);
    expect(f.nativeFetch).not.toHaveBeenCalled();
  });
});
