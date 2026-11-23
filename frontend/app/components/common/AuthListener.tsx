import { useEffect } from "react";
import { useDispatch } from "react-redux";
import type { Dispatch } from "redux";
import { login, logout } from "../../state/dispatchers/auth";
import type { ReduxAction } from "../../state/dispatchers/base";
import { useAuthStatus } from "../../hooks/useAuth";
import { SESSION_INVALID_EVENT } from "../../services/session-events";
import { clearAppSession } from "../../services/session";
import { checkAppSession } from "../../services/sessionCheck";
import { getDesktopHost } from "../../platform/desktopHost";

/** How long to wait before asking again while the API cannot be reached. */
export const SESSION_RETRY_MS = 3000;

export default function AuthListener() {
  const dispatch = useDispatch<Dispatch<ReduxAction>>();
  const { isLoaded } = useAuthStatus();

  useEffect(() => {
    const clearInvalidSession = () => dispatch(logout());
    window.addEventListener(SESSION_INVALID_EVENT, clearInvalidSession);

    let disposed = false;
    let retryTimer: number | null = null;

    const checkSession = async () => {
      const result = await checkAppSession();
      if (disposed) return;
      if (result.status === "signed-in") {
        dispatch(login(result.user));
      } else if (result.status === "signed-out") {
        clearInvalidSession();
      } else if (result.status === "unauthorized") {
        // The API rejects this sign-in. Drop it at the provider too: a leftover
        // provider session makes the next sign-in refuse to start.
        try {
          await clearAppSession();
        } catch (error) {
          console.error("Could not clear the rejected sign-in:", error);
        }
        if (!disposed) clearInvalidSession();
      } else {
        // The API is unreachable, for example while it restarts on a deploy.
        // That is not a verdict on the session: keep waiting and ask again.
        retryTimer = window.setTimeout(() => void checkSession(), SESSION_RETRY_MS);
      }
    };

    if (!isLoaded) {
      void checkSession();
    }

    // A desktop app (gaulatti/alcantara#431) signs in through the system browser and says when it is done.
    const stopDesktop = getDesktopHost()?.auth?.onChange((change) => {
      if (change.signedIn) void checkSession();
      else clearInvalidSession();
      if (change.error) console.error("Desktop sign-in:", change.error);
    });

    return () => {
      disposed = true;
      stopDesktop?.();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      window.removeEventListener(SESSION_INVALID_EVENT, clearInvalidSession);
    };
  }, [dispatch, isLoaded]);

  return null;
}
