import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Login, { type LoginFixtureState } from './login';

const { authStatus, signInWithRedirect } = vi.hoisted(() => ({
  authStatus: { isAuthenticated: false, isLoaded: true },
  signInWithRedirect: vi.fn(),
}));

vi.mock('aws-amplify/auth', () => ({ signInWithRedirect }));
vi.mock('../hooks/useAuth', () => ({
  useAuthStatus: () => authStatus,
}));

function renderLogin(state: LoginFixtureState) {
  return render(
    <MemoryRouter initialEntries={[`/login?auth-state=${state}`]}>
      <Login />
    </MemoryRouter>,
  );
}

describe('Login', () => {
  beforeEach(() => {
    authStatus.isAuthenticated = false;
    authStatus.isLoaded = true;
    signInWithRedirect.mockReset();
  });
  afterEach(cleanup);

  it.each([
    ['loading', 'Checking your session…'],
    ['ready', 'Welcome back.'],
    ['submitting', 'Welcome back.'],
    ['failure', 'Sign-in could not begin. Please retry or contact your administrator.'],
    ['authenticated', 'Opening the broadcast console…'],
  ] satisfies Array<[LoginFixtureState, string]>)('renders the %s state inside AuthShell', (state, marker) => {
    renderLogin(state);
    const shell = screen.getByRole('main');
    expect(shell).toHaveAttribute('data-layout', 'split');
    expect(shell).toHaveAttribute('data-side', 'start');
    expect(within(shell).getByText(marker)).toBeInTheDocument();
  });

  it('makes the redirect-in-progress state visible and unavailable for resubmission', () => {
    renderLogin('submitting');
    expect(screen.getByRole('button', { name: 'Redirecting…' })).toBeDisabled();
  });

  it('starts the existing Google redirect from a keyboard-submittable form', () => {
    signInWithRedirect.mockResolvedValue(undefined);
    renderLogin('ready');
    fireEvent.submit(screen.getByRole('button', { name: /sign in with google/i }).closest('form')!);
    expect(signInWithRedirect).toHaveBeenCalledWith({ provider: 'Google' });
  });

  it('redirects a real authenticated session to the existing destination', async () => {
    authStatus.isAuthenticated = true;
    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path='/login' element={<Login />} />
          <Route path='/' element={<p>Broadcast console</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Broadcast console')).toBeInTheDocument();
  });

  it('prevents duplicate redirect submissions while one is pending', async () => {
    let finishRedirect!: () => void;
    signInWithRedirect.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRedirect = resolve;
      }),
    );
    renderLogin('ready');
    const button = screen.getByRole('button', { name: /sign in with google/i });
    fireEvent.click(button);
    fireEvent.submit(button.closest('form')!);
    expect(signInWithRedirect).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    finishRedirect();
    await waitFor(() => expect(signInWithRedirect).toHaveBeenCalledTimes(1));
  });

  it('shows an accessible retryable error after redirect failure', async () => {
    signInWithRedirect.mockRejectedValueOnce(new Error('redirect failed'));
    renderLogin('ready');
    const button = screen.getByRole('button', { name: /sign in with google/i });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Sign-in could not begin. Please retry or contact your administrator.',
    );
    fireEvent.click(button);
    expect(signInWithRedirect).toHaveBeenCalledTimes(2);
  });
});
