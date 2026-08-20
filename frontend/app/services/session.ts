import { fetchAuthSession, signOut } from 'aws-amplify/auth';

export type Session = {
  userSub?: string;
  token?: string;
  payload?: Record<string, unknown>;
};

let localSession: Promise<Session> | undefined;

export const isTestAuth = () => import.meta.env.VITE_AUTH_MODE === 'test';

export async function getSession(): Promise<Session> {
  if (isTestAuth()) {
    const profile = import.meta.env.VITE_TEST_AUTH_PROFILE || 'admin';
    localSession ??= fetch(`${import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000'}/__test/session?profile=${encodeURIComponent(profile)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Test session failed (${response.status})`);
        const body = await response.json() as { accessToken: string; user: { sub: string; name: string; email: string } };
        return { userSub: body.user.sub, token: body.accessToken, payload: body.user };
      });
    return localSession;
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
    localSession = undefined;
    return;
  }
  await signOut();
}
