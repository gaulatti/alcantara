import { authReducer } from './auth';
import { preferencesReducer } from './preferences';
import { type ReduxAction } from '../dispatchers/base';
import defaultStore, { type State } from '../store';

export const reducers = (state: State = defaultStore, action: ReduxAction) => {
  let newState = authReducer(state, action);
  newState = preferencesReducer(newState, action);
  return newState;
};
