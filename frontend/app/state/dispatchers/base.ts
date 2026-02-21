import type { Action } from 'redux';

export interface ReduxAction extends Action {
  payload?: any;
}
