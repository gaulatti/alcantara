import { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { getSession } from '../../services/session';
import { takeLoginReturnPath } from '../../services/login-return';
import { login, setAuthLoaded } from '../../state/dispatchers/auth';
import { useAuthStatus } from '../../hooks/useAuth';

export default function AuthListener() {
  const dispatch = useDispatch();
  const { isLoaded } = useAuthStatus();

  useEffect(() => {
    const checkSession = async () => {
      try {
        const session = await getSession();
        if (session.userSub && session.token) {
          const payload = session.payload;
          const user = {
            id: session.userSub,
            email: (payload?.email as string) || '',
            name: payload?.name as string,
            picture: payload?.picture as string
          };
          dispatch(login(user));
          const returnTo = takeLoginReturnPath();
          if (returnTo) window.location.replace(returnTo);
        } else {
          dispatch(setAuthLoaded());
        }
      } catch {
        dispatch(setAuthLoaded());
      }
    };

    if (!isLoaded) {
      checkSession();
    }
  }, [dispatch, isLoaded]);

  return null;
}
