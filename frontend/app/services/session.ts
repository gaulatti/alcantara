import { fetchAuthSession, signOut } from "aws-amplify/auth";
import { getApiBaseUrl } from "../utils/apiBaseUrl";

export interface AppSession {
  userSub?: string;
  token?: string;
  payload?: Record<string, unknown>;
}

const rawFetch = globalThis.fetch.bind(globalThis);
let localSession: Promise<AppSession> | undefined;
const TEST_SESSION_KEY = "alcantara.testAuth.session";

function readStoredTestSession(): AppSession | null {
  try {
    const stored = JSON.parse(
      window.sessionStorage.getItem(TEST_SESSION_KEY) ?? "null",
    ) as
      | (AppSession & { expiresAt?: string })
      | null;
    if (
      !stored?.token ||
      !stored.userSub ||
      !stored.expiresAt ||
      Date.parse(stored.expiresAt) <= Date.now() + 30_000
    ) {
      return null;
    }
    return stored;
  } catch {
    return null;
  }
}

export function isTestAuth(): boolean {
  return import.meta.env.VITE_AUTH_MODE === "test";
}

export async function getAppSession(forceRefresh = false): Promise<AppSession> {
  if (isTestAuth()) {
    if (forceRefresh) {
      localSession = undefined;
      window.sessionStorage.removeItem(TEST_SESSION_KEY);
    }
    const identity = import.meta.env.VITE_TEST_AUTH_IDENTITY || "operator-a";
    const stored = readStoredTestSession();
    if (!localSession && stored) localSession = Promise.resolve(stored);
    localSession ??= rawFetch(
      `${getApiBaseUrl()}/__test/session?identity=${encodeURIComponent(identity)}`,
    )
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`Test session failed (${response.status})`);
        return response.json() as Promise<{
          accessToken: string;
          expiresAt: string;
          user: { sub: string; name: string; email: string };
        }>;
      })
      .then(({ accessToken, expiresAt, user }) => {
        const session = {
          userSub: user.sub,
          token: accessToken,
          payload: user,
          expiresAt,
        };
        window.sessionStorage.setItem(TEST_SESSION_KEY, JSON.stringify(session));
        return session;
      });
    return localSession;
  }
  const session = await fetchAuthSession({ forceRefresh });
  return {
    userSub: session.userSub,
    token: session.tokens?.idToken?.toString(),
    payload: session.tokens?.idToken?.payload as
      | Record<string, unknown>
      | undefined,
  };
}

export async function clearAppSession(): Promise<void> {
  if (isTestAuth()) {
    localSession = undefined;
    window.sessionStorage.removeItem(TEST_SESSION_KEY);
    return;
  }
  await signOut();
}
