import { type AuthStore } from '../reducers/auth';
import { type PreferencesStore } from '../reducers/preferences';

export interface State {
  auth: AuthStore;
  preferences: PreferencesStore;
}

const store: State = {
  auth: {
    loaded: false
  },
  preferences: {
    selectedLanguage: 'en'
  }
};

export default store;
