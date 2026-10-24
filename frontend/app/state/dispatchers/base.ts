import type { UnknownAction } from 'redux';

export interface ReduxAction extends UnknownAction {
  payload?: any;
}
