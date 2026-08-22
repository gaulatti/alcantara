import { getApiBaseUrl } from '../utils/apiBaseUrl';
import { getSession } from './session';

function isAlcantaraApiRequest(input: RequestInfo | URL): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = input instanceof Request ? input.url : input.toString();
    const requestUrl = new URL(raw, window.location.origin);
    if (requestUrl.pathname.startsWith('/__test/')) return false;
    const apiUrl = new URL(getApiBaseUrl(), window.location.origin);
    if (requestUrl.origin !== apiUrl.origin) return false;
    const prefix = apiUrl.pathname.replace(/\/$/, '');
    return !prefix || prefix === '/' || requestUrl.pathname.startsWith(prefix);
  } catch {
    return false;
  }
}

export function installAuthenticatedFetch(): void {
  if (typeof window === 'undefined') return;
  const marker = '__alcantaraAuthenticatedFetchInstalled';
  const markedWindow = window as typeof window & Record<string, unknown>;
  if (markedWindow[marker]) return;
  markedWindow[marker] = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isAlcantaraApiRequest(input)) return nativeFetch(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has('Authorization')) {
      try {
        const { token } = await getSession();
        if (token) headers.set('Authorization', `Bearer ${token}`);
      } catch {
        // Public runtime endpoints intentionally continue without a session.
      }
    }
    return nativeFetch(input, { ...init, headers });
  };
}
