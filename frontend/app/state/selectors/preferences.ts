import { type State } from '../store';

const selectLanguage = (state: State): string => {
  return state.preferences.selectedLanguage;
};

export { selectLanguage };
