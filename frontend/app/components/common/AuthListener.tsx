import { useEffect } from "react";
import { useDispatch } from "react-redux";
import type { Dispatch } from "redux";
import { login, logout } from "../../state/dispatchers/auth";
import type { ReduxAction } from "../../state/dispatchers/base";
import { useAuthStatus } from "../../hooks/useAuth";
import { SESSION_INVALID_EVENT } from "../../services/session-events";
import { getAppSession } from "../../services/session";

export default function AuthListener() {
  const dispatch = useDispatch<Dispatch<ReduxAction>>();
  const { isLoaded } = useAuthStatus();

  useEffect(() => {
    const clearInvalidSession = () => dispatch(logout());
    window.addEventListener(SESSION_INVALID_EVENT, clearInvalidSession);

    const checkSession = async () => {
      try {
        const session = await getAppSession();
        if (session.userSub && session.token) {
          const payload = session.payload;
          const user = {
            id: session.userSub,
            email: (payload?.email as string) || "",
            name: payload?.name as string,
            picture: payload?.picture as string,
          };
          dispatch(login(user));
        } else {
          clearInvalidSession();
        }
      } catch {
        clearInvalidSession();
      }
    };

    if (!isLoaded) {
      void checkSession();
    }

    return () =>
      window.removeEventListener(SESSION_INVALID_EVENT, clearInvalidSession);
  }, [dispatch, isLoaded]);

  return null;
}
