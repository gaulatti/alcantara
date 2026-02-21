import { type ReduxAction } from '../dispatchers/base';
import defaultStore, { type State } from '../store';

export interface PreferencesStore {
  selectedLanguage: string;
}

const preferencesReducer = (state: State = defaultStore, action: ReduxAction) => {
  switch (action.type) {
    case 'SET_LANGUAGE':
      return {
        ...state,
        preferences: { ...state.preferences, selectedLanguage: action.payload }
      };
    default:
      return state;
  }
};

export { preferencesReducer };
