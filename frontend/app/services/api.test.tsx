import { AxiosError, AxiosHeaders, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ getAppSession: vi.fn(), reportInvalidSession: vi.fn() }));
vi.mock('./session', () => ({ getAppSession: auth.getAppSession }));
vi.mock('./session-events', () => ({ reportInvalidSession: auth.reportInvalidSession }));
vi.mock('../utils/apiBaseUrl', () => ({
  getApiBaseUrl: () => 'https://api.example', apiUrl: (path: string) => `https://api.example${path}`,
}));

beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

function response(config: InternalAxiosRequestConfig, status = 200, data: unknown = {}): AxiosResponse {
  return { config, status, statusText: String(status), data, headers: new AxiosHeaders() };
}
function failure(config: InternalAxiosRequestConfig, status: number, data: unknown = {}) {
  return new AxiosError(`HTTP ${status}`, 'ERR_BAD_REQUEST', config, undefined, response(config, status, data));
}

describe('API authorization and failure boundaries', () => {
  it('attaches the current account token and returns the authoritative response', async () => {
    auth.getAppSession.mockResolvedValue({ token: 'account-token' });
    const { api } = await import('./api');
    const transport = vi.fn(async (config: InternalAxiosRequestConfig) => response(config, 200, { state: 'ready' }));
    api.defaults.adapter = transport;
    await expect(api.get('/program/main/state')).resolves.toMatchObject({ data: { state: 'ready' } });
    expect(transport.mock.calls[0][0].headers.get('Authorization')).toBe('Bearer account-token');
  });
  it('leaves missing or unavailable account credentials to server authorization', async () => {
    auth.getAppSession.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('account unavailable'));
    const { api } = await import('./api');
    const transport = vi.fn(async (config: InternalAxiosRequestConfig) => response(config));
    api.defaults.adapter = transport;
    await api.get('/public');
    await api.get('/public');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls.every(([config]) => !config.headers.has('Authorization'))).toBe(true);
  });
  it('refreshes once after401 and retries with the fresh cached account token', async () => {
    let token = 'old-token';
    auth.getAppSession.mockImplementation(async (force: boolean) => {
      if (force) token = 'fresh-token';
      return { token };
    });
    const { api } = await import('./api');
    const authorization: unknown[] = [];
    api.defaults.adapter = async (config) => {
      authorization.push(config.headers.get('Authorization'));
      if (authorization.length === 1) throw failure(config, 401);
      return response(config, 200, { accepted: true });
    };
    await expect(api.post('/command', { sceneId: 7 })).resolves.toMatchObject({ data: { accepted: true } });
    expect(authorization).toEqual(['Bearer old-token', 'Bearer fresh-token']);
    expect(auth.getAppSession).toHaveBeenCalledWith(true);
    expect(auth.reportInvalidSession).not.toHaveBeenCalled();
  });
  it('does not retry indefinitely when the refreshed account is still unauthorized', async () => {
    auth.getAppSession.mockResolvedValue({ token: 'denied' });
    const { api } = await import('./api');
    const transport = vi.fn(async (config: InternalAxiosRequestConfig) => { throw failure(config, 401); });
    api.defaults.adapter = transport;
    await expect(api.get('/private')).rejects.toThrow('HTTP 401');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(auth.reportInvalidSession).toHaveBeenCalled();
  });
  it.each([{}, new Error('account unavailable')])('invalidates an unavailable refreshed account %j', async (refreshed) => {
    auth.getAppSession.mockResolvedValueOnce({ token: 'old' });
    if (refreshed instanceof Error) auth.getAppSession.mockRejectedValueOnce(refreshed);
    else auth.getAppSession.mockResolvedValueOnce(refreshed);
    const { api } = await import('./api');
    const transport = vi.fn(async (config: InternalAxiosRequestConfig) => { throw failure(config, 401); });
    api.defaults.adapter = transport;
    await expect(api.get('/private')).rejects.toThrow(refreshed instanceof Error ? 'account unavailable' : 'Refreshed session has no ID token');
    expect(transport).toHaveBeenCalledOnce();
    expect(auth.reportInvalidSession).toHaveBeenCalledOnce();
  });
  it('preserves ordinary HTTP failures without refreshing the account', async () => {
    auth.getAppSession.mockResolvedValue({ token: 'account-token' });
    const { api } = await import('./api');
    api.defaults.adapter = async (config) => { throw failure(config, 403); };
    await expect(api.get('/forbidden')).rejects.toThrow('HTTP 403');
    expect(auth.getAppSession).toHaveBeenCalledTimes(1);
    expect(auth.reportInvalidSession).not.toHaveBeenCalled();
  });
  it('keeps an upstream request-interceptor failure from reaching transport', async () => {
    const { api } = await import('./api');
    const transport = vi.fn();
    api.defaults.adapter = transport;
    api.interceptors.request.use(() => { throw new Error('invalid request'); });
    await expect(api.get('/private')).rejects.toThrow('invalid request');
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('fetch adapter and operator error explanations', () => {
  it('preserves request payload and headers while attaching an available account token', async () => {
    auth.getAppSession.mockResolvedValue({ token: 'account-token' });
    const transport = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));
    vi.stubGlobal('fetch', transport);
    const { authFetch } = await import('./api');
    await authFetch('/command', { method: 'POST', headers: { 'X-Trace': 'attempt' }, body: 'payload' });
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe('https://api.example/command');
    expect(init).toMatchObject({ method: 'POST', body: 'payload' });
    expect(new Headers(init?.headers).get('X-Trace')).toBe('attempt');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer account-token');
  });
  it('preserves missing and unavailable account sessions without inventing credentials', async () => {
    auth.getAppSession.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('unavailable'));
    const transport = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));
    vi.stubGlobal('fetch', transport);
    const { authFetch } = await import('./api');
    await authFetch('/public');
    await authFetch('/public');
    expect(transport).toHaveBeenCalledTimes(2);
    for (const [, init] of transport.mock.calls) expect(new Headers(init?.headers).has('Authorization')).toBe(false);
  });
  it('explains supported backend errors and preserves unexpected failures', async () => {
    const { handleApiError } = await import('./api');
    const config = { headers: new AxiosHeaders() } as InternalAxiosRequestConfig;
    expect(handleApiError(failure(config, 409, { error: 'Revision conflict' }))).toBe('Revision conflict');
    expect(handleApiError(failure(config, 404))).toBe('Resource not found');
    expect(handleApiError(failure(config, 403))).toBe('Access denied');
    expect(handleApiError(failure(config, 500))).toBe('Server error. Please try again later.');
    expect(handleApiError(failure(config, 502))).toBe('HTTP 502');
    expect(handleApiError(new AxiosError('network unavailable'))).toBe('network unavailable');
    expect(handleApiError(new Error('unknown'))).toBe('An unexpected error occurred');
  });
});
