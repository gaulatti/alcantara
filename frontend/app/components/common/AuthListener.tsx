import { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { fetchAuthSession } from 'aws-amplify/auth';
import { login, setAuthLoaded } from '../../state/dispatchers/auth';
import { useAuthStatus } from '../../hooks/useAuth';

export default function AuthListener() {
  const dispatch = useDispatch();
  const { isLoaded } = useAuthStatus();

  useEffect(() => {
    const checkSession = async () => {
      try {
        const session = await fetchAuthSession();
        if (session.userSub && session.tokens) {
          const payload = session.tokens.idToken?.payload;
          const user = {
            id: session.userSub,
            email: (payload?.email as string) || '',
            name: payload?.name as string,
            picture: payload?.picture as string
          };
          dispatch(login(user));
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
