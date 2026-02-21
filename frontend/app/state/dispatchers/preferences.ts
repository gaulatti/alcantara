import { type ReduxAction } from './base';

const setLanguage = (language: string): ReduxAction => {
  return { type: 'SET_LANGUAGE', payload: language };
};

export { setLanguage };
