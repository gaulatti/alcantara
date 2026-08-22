import { fetchAuthSession } from 'aws-amplify/auth';
import { getApiBaseUrl } from '../utils/apiBaseUrl';

const nativeFetch = globalThis.fetch.bind(globalThis);
let installed = false;

const isBackendRequest = (input: RequestInfo | URL): boolean => {
  const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const backendUrl = new URL(getApiBaseUrl());
  const targetUrl = new URL(requestUrl, window.location.origin);
  const backendPath = backendUrl.pathname.replace(/\/$/, '');

  return (
    targetUrl.origin === backendUrl.origin &&
    (!backendPath || targetUrl.pathname === backendPath || targetUrl.pathname.startsWith(`${backendPath}/`))
  );
};

const authenticatedBackendFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const requestHeaders = input instanceof Request ? input.headers : undefined;
  const headers = new Headers(init?.headers ?? requestHeaders);

  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  } catch {
    // Preserve the backend's normal unauthenticated response when no session exists.
  }

  return nativeFetch(input, { ...init, headers });
};

export const installAuthenticatedFetch = (): void => {
  if (typeof window === 'undefined' || installed) return;

  installed = true;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    isBackendRequest(input) ? authenticatedBackendFetch(input, init) : nativeFetch(input, init);
};
