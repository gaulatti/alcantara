import { type Store, applyMiddleware, legacy_createStore as createStore } from 'redux';
import createSagaMiddleware from 'redux-saga';
import { reducers } from './reducers';
import { rootSaga } from './sagas';

let store: Store;

const getStore = () => {
  if (!store) {
    const sagaMiddleware = createSagaMiddleware();

    store = createStore(reducers as any, applyMiddleware(sagaMiddleware));
    sagaMiddleware.run(rootSaga);
  }

  return { store };
};

export { getStore };
