import { fetchAuthSession, signOut } from 'aws-amplify/auth';

export type Session = {
  userSub?: string;
  token?: string;
  payload?: Record<string, unknown>;
};

export async function getSession(): Promise<Session> {
  const session = await fetchAuthSession();
  return {
    userSub: session.userSub,
    token: session.tokens?.idToken?.toString(),
    payload: session.tokens?.idToken?.payload
  };
}

export async function clearSession(): Promise<void> {
  await signOut();
}
