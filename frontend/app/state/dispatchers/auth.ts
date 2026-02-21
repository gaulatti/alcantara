import { type User } from '../../models/user';
import { type ReduxAction } from './base';

export interface LoginAction extends ReduxAction {
  payload: User | undefined;
}

const login = (user?: User): LoginAction => {
  return { type: 'LOGIN', payload: user };
};

const logout = (): ReduxAction => {
  return { type: 'LOGOUT' };
};

const setCurrentUser = (user: User): ReduxAction => {
  return { type: 'SET_CURRENT_USER', payload: user };
};

const setAuthLoaded = (): ReduxAction => {
  return { type: 'SET_AUTH_LOADED' };
};

export { login, logout, setCurrentUser, setAuthLoaded };
