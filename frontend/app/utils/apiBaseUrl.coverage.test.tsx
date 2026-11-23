import { afterEach, describe, expect, it, vi } from 'vitest';

// The base URL is read once when the module loads, so each case loads a fresh copy.
async function load(env: { VITE_API_BASE_URL?: string; DEV: boolean }) {
  vi.resetModules();
  vi.stubEnv('VITE_API_BASE_URL', env.VITE_API_BASE_URL ?? '');
  vi.stubEnv('DEV', env.DEV);
  return import('./apiBaseUrl');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('API base URL', () => {
  it('uses the configured URL, without a trailing slash, and joins paths with exactly one slash', async () => {
    const api = await load({ VITE_API_BASE_URL: 'https://api.example.test/', DEV: false });
    expect(api.getApiBaseUrl()).toBe('https://api.example.test');
    expect(api.apiUrl('/programs')).toBe('https://api.example.test/programs');
    expect(api.apiUrl('programs')).toBe('https://api.example.test/programs');
  });

  it('refuses to build a request URL in a production build with no URL configured', async () => {
    const api = await load({ DEV: false });
    expect(api.API_BASE_URL).toBeUndefined();
    expect(() => api.getApiBaseUrl()).toThrow('VITE_API_BASE_URL must be set for frontend API requests.');
  });

  it('in development, points at port 3000 on the page host, bracketing IPv6', async () => {
    vi.stubGlobal('location', { ...window.location, hostname: 'console.local.test' });
    expect((await load({ DEV: true })).getApiBaseUrl()).toBe('http://console.local.test:3000');
    vi.stubGlobal('location', { ...window.location, hostname: '::1' });
    expect((await load({ DEV: true })).getApiBaseUrl()).toBe('http://[::1]:3000');
    vi.stubGlobal('location', { ...window.location, hostname: '' });
    expect((await load({ DEV: true })).getApiBaseUrl()).toBe('http://127.0.0.1:3000');
  });

  it('in development outside a browser, falls back to the loopback address', async () => {
    vi.stubGlobal('window', undefined);
    expect((await load({ DEV: true })).getApiBaseUrl()).toBe('http://127.0.0.1:3000');
  });
});
