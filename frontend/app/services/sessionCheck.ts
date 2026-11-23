import type { User } from "../models/user";
import { getApiBaseUrl } from "../utils/apiBaseUrl";
import { getAppSession } from "./session";

/**
 * What the sign-in provider and the API say about the current session.
 *
 * - `signed-in`: the provider has a session and the API accepts it.
 * - `signed-out`: the provider has no session.
 * - `unauthorized`: the provider has a session but the API rejects it (401 or 403).
 * - `unavailable`: the answer could not be obtained (network error, API restarting,
 *   5xx). This says nothing about the session, so it must never sign the user out.
 */
export type SessionCheck =
  | { status: "signed-in"; user: User }
  | { status: "signed-out" }
  | { status: "unauthorized" }
  | { status: "unavailable" };

export async function checkAppSession(forceRefresh = false): Promise<SessionCheck> {
  let session;
  try {
    session = await getAppSession(forceRefresh);
  } catch {
    return { status: "unavailable" };
  }
  if (!session.userSub || !session.token) return { status: "signed-out" };

  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}/auth/me`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
  } catch {
    return { status: "unavailable" };
  }
  if (response.status === 401 || response.status === 403) return { status: "unauthorized" };
  if (!response.ok) return { status: "unavailable" };

  let authorized: { principalId?: unknown };
  try {
    authorized = (await response.json()) as { principalId?: unknown };
  } catch {
    return { status: "unavailable" };
  }
  const payload = session.payload;
  return {
    status: "signed-in",
    user: {
      id: session.userSub,
      principalId:
        typeof authorized.principalId === "string" && authorized.principalId.trim()
          ? authorized.principalId.trim()
          : null,
      email: (payload?.email as string) || "",
      name: payload?.name as string,
      picture: payload?.picture as string,
    },
  };
}
