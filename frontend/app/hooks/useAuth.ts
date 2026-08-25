import { useDispatch, useSelector } from "react-redux";
import { useNavigate } from "react-router";
import type { Dispatch } from "redux";
import { logout as logoutDispatcher } from "../state/dispatchers/auth";
import type { ReduxAction } from "../state/dispatchers/base";
import {
  isAuthenticated as isAuthenticatedSelector,
  isLoaded as isLoadedSelector,
} from "../state/selectors/auth";
import { clearAppSession } from "../services/session";

const useLogout = () => {
  const { isAuthenticated, isLoaded } = useAuthStatus();
  const dispatch = useDispatch<Dispatch<ReduxAction>>();
  const navigate = useNavigate();

  const logout = (): void => {
    if (isAuthenticated && isLoaded) {
      clearAppSession()
        .then(() => {
          dispatch(logoutDispatcher());
          navigate("/login");
        })
        .catch((err) => {
          console.error("Error signing out: ", err);
          dispatch(logoutDispatcher());
          navigate("/login");
        });
    }
  };

  return {
    logout,
  };
};

const useAuthStatus = () => {
  const isAuthenticated = useSelector(isAuthenticatedSelector);
  const isLoaded = useSelector(isLoadedSelector);

  return {
    isAuthenticated,
    isLoaded,
  };
};

export { useAuthStatus, useLogout };
