import { getApiBaseUrl } from "../utils/apiBaseUrl";
import { reportInvalidSession } from "./session-events";
import { getAppSession } from "./session";

const nativeFetch = globalThis.fetch.bind(globalThis);
let installed = false;
class SessionUnavailableError extends Error {}

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

export const installAuthenticatedFetch = (): void => {
  if (typeof window === "undefined" || installed) return;

  installed = true;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    isBackendRequest(input)
      ? authenticatedBackendFetch(input, init)
      : nativeFetch(input, init);
};
