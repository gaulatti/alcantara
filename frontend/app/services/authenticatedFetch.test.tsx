import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('authenticated fetch installation', () => {
  it('leaves every Program renderer API request public', async () => {
    const nativeFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const getAppSession = vi.fn().mockResolvedValue({});
    vi.stubGlobal('fetch', nativeFetch);
    vi.doMock('../utils/apiBaseUrl', () => ({ getApiBaseUrl: () => 'https://api.alcantara.test' }));
    vi.doMock('./session', () => ({ getAppSession }));
    vi.doMock('./session-events', () => ({ reportInvalidSession: vi.fn() }));
    window.history.replaceState({}, '', '/program/modoitaliano');

    const { installAuthenticatedFetch } = await import('./authenticatedFetch');
    installAuthenticatedFetch();

    await fetch('https://api.alcantara.test/program/modoitaliano/state');
    await fetch('https://api.alcantara.test/media-groups/34');

    expect(getAppSession).not.toHaveBeenCalled();
    expect(nativeFetch).toHaveBeenCalledTimes(2);
    expect(nativeFetch).toHaveBeenNthCalledWith(1, 'https://api.alcantara.test/program/modoitaliano/state', undefined);
    expect(nativeFetch).toHaveBeenNthCalledWith(2, 'https://api.alcantara.test/media-groups/34', undefined);
  });

  it('continues authenticating protected Control requests', async () => {
    const nativeFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const getAppSession = vi.fn().mockResolvedValue({ token: 'operator-token' });
    vi.stubGlobal('fetch', nativeFetch);
    vi.doMock('../utils/apiBaseUrl', () => ({ getApiBaseUrl: () => 'https://api.alcantara.test' }));
    vi.doMock('./session', () => ({ getAppSession }));
    vi.doMock('./session-events', () => ({ reportInvalidSession: vi.fn() }));

    const { installAuthenticatedFetch } = await import('./authenticatedFetch');
    installAuthenticatedFetch();

    await fetch('https://api.alcantara.test/program');

    expect(getAppSession).toHaveBeenCalledOnce();
    const requestInit = nativeFetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(requestInit.headers).get('Authorization')).toBe('Bearer operator-token');
  });
});
