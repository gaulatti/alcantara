import { type User } from '../../models/user';
import { type ReduxAction } from '../dispatchers/base';
import defaultStore, { type State } from '../store';

export interface AuthStore {
  currentUser?: User;
  loaded: boolean;
}

const authReducer = (state: State = defaultStore, action: ReduxAction) => {
  switch (action.type) {
    case 'LOGIN':
      return {
        ...state,
        auth: { ...state.auth, currentUser: action.payload as User, loaded: true }
      };

    case 'persist/REHYDRATE':
      if (action.payload) {
        return {
          ...state,
          ...action.payload,
          auth: { ...action.payload.auth, loaded: state.auth.loaded || false }
        };
      }
      return state;

    case 'LOGOUT':
      return {
        ...state,
        auth: { ...defaultStore.auth, loaded: true }
      };

    case 'SET_AUTH_LOADED':
      return {
        ...state,
        auth: { ...state.auth, loaded: true }
      };

    case 'SET_CURRENT_USER':
      return {
        ...state,
        auth: { ...state.auth, currentUser: action.payload as User, loaded: true }
      };

    default:
      return state;
  }
};

export { authReducer };
