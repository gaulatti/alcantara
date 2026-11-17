import type { Action } from 'redux';

export interface ReduxAction extends Action {
  payload?: any;
  [extraProps: string]: unknown;
}
