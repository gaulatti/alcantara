import { type User } from '../../models/user';
import { type State } from '../store';

const isAuthenticated = (state: State): boolean => {
  return !!state.auth.currentUser;
};

const currentUser = (state: State): User | undefined => {
  return state.auth.currentUser;
};

const isLoaded = (state: State): boolean => {
  return state.auth.loaded;
};

export { isAuthenticated, isLoaded, currentUser };
