import { cleanup, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { legacy_createStore as createStore } from 'redux';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, it } from 'vitest';
import { reducers } from '../state/reducers';
import { login } from '../state/dispatchers/auth';
import Logout from './logout';

afterEach(cleanup);

it('clears the authenticated identity through real Redux actions before replacing navigation with login', async () => {
  const store = createStore(reducers);
  store.dispatch(login({ id: 'fictional-operator', email: 'operator@example.invalid' }));
  expect(store.getState().auth.currentUser?.id).toBe('fictional-operator');
  render(<Provider store={store}>
    <MemoryRouter initialEntries={['/logout']}>
      <Routes>
        <Route path='/logout' element={<Logout />} />
        <Route path='/login' element={<p>Login screen</p>} />
      </Routes>
    </MemoryRouter>
  </Provider>);
  expect(await screen.findByText('Login screen')).toBeInTheDocument();
  expect(store.getState().auth.currentUser).toBeUndefined();
  expect(store.getState().auth.loaded).toBe(true);
});
