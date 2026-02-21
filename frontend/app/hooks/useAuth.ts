import { signOut } from 'aws-amplify/auth';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router';
import { logout as logoutDispatcher } from '../state/dispatchers/auth';
import { isAuthenticated as isAuthenticatedSelector, isLoaded as isLoadedSelector } from '../state/selectors/auth';

const useLogout = () => {
  const { isAuthenticated, isLoaded } = useAuthStatus();
  const dispatch = useDispatch();
  const navigate = useNavigate();

  const logout = (): void => {
    if (isAuthenticated && isLoaded) {
      signOut()
        .then(() => {
          dispatch(logoutDispatcher());
          navigate('/login');
        })
        .catch((err) => {
          console.error('Error signing out: ', err);
          dispatch(logoutDispatcher());
          navigate('/login');
        });
    }
  };

  return {
    logout
  };
};

const useAuthStatus = () => {
  const isAuthenticated = useSelector(isAuthenticatedSelector);
  const isLoaded = useSelector(isLoadedSelector);

  return {
    isAuthenticated,
    isLoaded
  };
};

export { useAuthStatus, useLogout };
