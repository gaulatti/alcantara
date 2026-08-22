import { fetchAuthSession, signOut } from 'aws-amplify/auth';
import { createExpiringSessionCache } from './expiring-session-cache';

export type Session = {
  userSub?: string;
  token?: string;
  payload?: Record<string, unknown>;
};

const localSession = createExpiringSessionCache<Session>();

export const isTestAuth = () => import.meta.env.VITE_AUTH_MODE === 'test';

export async function getSession(): Promise<Session> {
  if (isTestAuth()) {
    const profile = import.meta.env.VITE_TEST_AUTH_PROFILE || 'admin';
    return localSession.get(async () => {
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000'}/__test/session?profile=${encodeURIComponent(profile)}`);
      if (!response.ok) throw new Error(`Test session failed (${response.status})`);
      const body = await response.json() as {
        accessToken: string;
        expiresAt: string;
        user: { sub: string; name: string; email: string };
      };
      return {
        value: { userSub: body.user.sub, token: body.accessToken, payload: body.user },
        expiresAt: body.expiresAt,
      };
    });
  }
  const session = await fetchAuthSession();
  return {
    userSub: session.userSub,
    token: session.tokens?.idToken?.toString(),
    payload: session.tokens?.idToken?.payload
  };
}

export async function clearSession(): Promise<void> {
  if (isTestAuth()) {
    localSession.clear();
    return;
  }
  await signOut();
}
