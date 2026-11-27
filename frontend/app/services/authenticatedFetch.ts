import { getApiBaseUrl } from "../utils/apiBaseUrl";
import { reportInvalidSession } from "./session-events";
import { getAppSession } from "./session";

const nativeFetch = globalThis.fetch.bind(globalThis);
let installed = false;
class SessionUnavailableError extends Error {}

export const isPublicProgramRendererPath = (pathname: string): boolean =>
  /^\/program\/[^/]+\/?$/.test(pathname);

/** The public MCP instructions page (gaulatti/bastille#35): it reads one public list and must not need a session. */
export const isPublicConnectPath = (pathname: string): boolean => /^\/connect\/?$/.test(pathname);

/**
 * The call pages nobody signs in to (gaulatti/alcantara#354): a guest's /guest/<invitation>, which authenticates with
 * its invitation, and the machine-only /return-router/<programId>, which sends its renderer key. With no session the
 * wrapper threw "Authenticated session has no ID token" before any request, so in production no guest could join.
 */
export const isPublicCallPath = (pathname: string): boolean =>
  /^\/(guest|return-router)\/[^/]+\/?$/.test(pathname);

const isBackendRequest = (input: RequestInfo | URL): boolean => {
  const requestUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const backendUrl = new URL(getApiBaseUrl());
  const targetUrl = new URL(requestUrl, window.location.origin);
  const backendPath = backendUrl.pathname.replace(/\/$/, "");

  return (
    targetUrl.origin === backendUrl.origin &&
    (!backendPath ||
      targetUrl.pathname === backendPath ||
      targetUrl.pathname.startsWith(`${backendPath}/`))
  );
};

const authenticatedBackendFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const requestHeaders = input instanceof Request ? input.headers : undefined;

  const send = async (forceRefresh = false): Promise<Response> => {
    const attemptHeaders = new Headers(init?.headers ?? requestHeaders);
    let session;
    try {
      session = await getAppSession(forceRefresh);
    } catch {
      throw new SessionUnavailableError();
    }
    const token = session.token;
    if (!token) throw new Error("Authenticated session has no ID token");
    attemptHeaders.set("Authorization", `Bearer ${token}`);
    const requestInput = input instanceof Request ? input.clone() : input;
    return nativeFetch(requestInput, { ...init, headers: attemptHeaders });
  };

  let response: Response;
  try {
    response = await send();
  } catch (error) {
    if (error instanceof SessionUnavailableError) {
      reportInvalidSession();
      return nativeFetch(input, init);
    }
    throw error;
  }

  if (response.status !== 401) return response;

  try {
    const retried = await send(true);
    if (retried.status === 401) reportInvalidSession();
    return retried;
  } catch (error) {
    if (error instanceof SessionUnavailableError) reportInvalidSession();
    return response;
  }
};

/** How long a backend request keeps retrying a backend that is handing over before its 503 reaches the caller. */
export const TAKEOVER_RETRY_WINDOW_MS = 6_000;

/**
 * The wait a 503 with Retry-After asks for, or null for any other answer. During a backend handover
 * (gaulatti/alcantara#873) the instance that is stopping, or a standby past its hold, answers 503 with Retry-After
 * before the request runs, so it is safe to send again, and the next one reaches the instance that took over.
 */
const takeoverWait = (response: Response): number | null => {
  if (response.status !== 503) return null;
  const header = response.headers.get("Retry-After");
  if (header === null) return null;
  const seconds = Number(header);
  if (!header.trim() || !Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds, 5) * 1000;
};

/** Sends, and sends again quietly while the backend answers a handover's 503, for up to TAKEOVER_RETRY_WINDOW_MS. */
const retryingTakeover = async (
  send: (retry: boolean) => Promise<Response>,
  signal: AbortSignal | null | undefined,
): Promise<Response> => {
  const startedAt = Date.now();
  let response = await send(false);
  for (;;) {
    const wait = takeoverWait(response);
    if (wait === null || signal?.aborted || Date.now() - startedAt + wait > TAKEOVER_RETRY_WINDOW_MS) return response;
    await new Promise((resolve) => setTimeout(resolve, wait));
    if (signal?.aborted) return response;
    response = await send(true);
  }
};

export const installAuthenticatedFetch = (): void => {
  if (typeof window === "undefined" || installed) return;

  installed = true;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isBackendRequest(input)) return nativeFetch(input, init);
    const publicPage =
      isPublicProgramRendererPath(window.location.pathname) ||
      isPublicConnectPath(window.location.pathname) ||
      isPublicCallPath(window.location.pathname);
    const sendOnce = (target: RequestInfo | URL) =>
      publicPage ? nativeFetch(target, init) : authenticatedBackendFetch(target, init);
    // A streamed body cannot be sent twice.
    if (init?.body instanceof ReadableStream) return sendOnce(input);
    // A Request's body is read by the first send, so a retry sends a copy taken before it.
    const spare = input instanceof Request ? input.clone() : null;
    return retryingTakeover(
      (retry) => sendOnce(retry && spare ? spare.clone() : input),
      init?.signal ?? (input instanceof Request ? input.signal : undefined),
    );
  };
};
