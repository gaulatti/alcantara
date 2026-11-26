import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Login, { DESKTOP_RETRY_MS, type LoginFixtureState } from './login';

const { authStatus, signInWithRedirect, checkAppSession, clearAppSession, dispatch } = vi.hoisted(() => ({
  authStatus: { isAuthenticated: false, isLoaded: true },
  signInWithRedirect: vi.fn(),
  checkAppSession: vi.fn(),
  clearAppSession: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock('aws-amplify/auth', () => ({ signInWithRedirect }));
vi.mock('react-redux', () => ({ useDispatch: () => dispatch }));
vi.mock('../services/sessionCheck', () => ({ checkAppSession }));
vi.mock('../services/session', () => ({ clearAppSession }));
// gaulatti/alcantara#431: no desktop host unless a test plugs one in.
const desktop = vi.hoisted(() => ({ host: null as null | Record<string, unknown> }));
vi.mock('@desktop-host', () => ({
  get default() {
    return desktop.host;
  },
}));

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
    checkAppSession.mockReset();
    clearAppSession.mockReset();
    dispatch.mockReset();
  });
  afterEach(() => {
    cleanup();
    desktop.host = null;
  });

  it('signs in through a desktop app instead of the browser redirect, and shows its failure', async () => {
  const listeners: Array<(change: { signedIn: boolean; error: string | null }) => void> = [];
  const unsubscribe = vi.fn();
  const auth = {
    currentSession: vi.fn(),
    signIn: vi.fn(async () => undefined),
    signOut: vi.fn(),
    onChange: vi.fn((listener: (change: { signedIn: boolean; error: string | null }) => void) => {
      listeners.push(listener);
      return unsubscribe;
    }),
  };
    desktop.host = { auth };
    renderLogin('ready');
    fireEvent.submit(screen.getByRole('button', { name: /sign in with google/i }).closest('form')!);
    await waitFor(() => expect(auth.signIn).toHaveBeenCalledTimes(1));
    expect(signInWithRedirect).not.toHaveBeenCalled();
    listeners[0]({ signedIn: false, error: 'The sign-in return did not match' });
    expect(await screen.findByText('Sign-in could not begin. Please retry or contact your administrator.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in with google/i })).toBeEnabled();
    fireEvent.submit(screen.getByRole('button', { name: /sign in with google/i }).closest('form')!);
    await waitFor(() => expect(auth.signIn).toHaveBeenCalledTimes(2));
  });

  // gaulatti/alcantara#527 (stronger pass, lines 84-85): when the browser the desktop app opened never reports back,
  // the button stays busy only for DESKTOP_RETRY_MS, then lets the operator try again.
  it('lets a desktop sign-in that never reports back be tried again after the retry window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const auth = {
        currentSession: vi.fn(),
        signIn: vi.fn(async () => undefined),
        signOut: vi.fn(),
        onChange: vi.fn(() => vi.fn()),
      };
      desktop.host = { auth };
      renderLogin('ready');
      const button = () => screen.getByRole('button', { name: /sign in with google/i });
      const busy = () => screen.getByRole('button', { name: /redirecting/i });
      fireEvent.submit(button().closest('form')!);
      await act(async () => {});
      expect(auth.signIn).toHaveBeenCalledTimes(1);
      expect(busy()).toBeDisabled();
      act(() => {
        vi.advanceTimersByTime(DESKTOP_RETRY_MS - 1);
      });
      expect(busy()).toBeDisabled();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(button()).toBeEnabled();
      expect(screen.queryByText(/Sign-in could not begin/)).toBeNull();
      fireEvent.submit(button().closest('form')!);
      await act(async () => {});
      expect(auth.signIn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the sign-in failure when the desktop app refuses to open the browser', async () => {
    const auth = {
      currentSession: vi.fn(),
      signIn: vi.fn(async () => {
        throw new Error('no browser');
      }),
      signOut: vi.fn(),
      onChange: vi.fn(() => vi.fn()),
    };
    desktop.host = { auth };
    renderLogin('ready');
    fireEvent.submit(screen.getByRole('button', { name: /sign in with google/i }).closest('form')!);
    expect(await screen.findByText('Sign-in could not begin. Please retry or contact your administrator.')).toBeInTheDocument();
    expect(auth.signIn).toHaveBeenCalledTimes(1);
    expect(signInWithRedirect).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /sign in with google/i })).toBeEnabled();
  });

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

  describe('when the provider still holds a sign-in', () => {
    const alreadySignedIn = Object.assign(new Error('There is already a signed in user.'), { name: 'UserAlreadyAuthenticatedException' });
    const submit = () => fireEvent.submit(screen.getByRole('button', { name: /sign in with google/i }).closest('form')!);

    it('uses that session when the API accepts it, instead of refusing to start', async () => {
      signInWithRedirect.mockRejectedValue(alreadySignedIn);
      const user = { id: 'sub-1', principalId: 'p-1', email: 'a@example.test' };
      checkAppSession.mockResolvedValue({ status: 'signed-in', user });
      renderLogin('ready');
      submit();
      await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'LOGIN', payload: user }));
      expect(checkAppSession).toHaveBeenCalledWith(true);
      expect(clearAppSession).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('drops the leftover sign-in when the API rejects it, so the next attempt can start', async () => {
      signInWithRedirect.mockRejectedValue(alreadySignedIn);
      checkAppSession.mockResolvedValue({ status: 'unauthorized' });
      clearAppSession.mockResolvedValue(undefined);
      renderLogin('ready');
      submit();
      await waitFor(() => expect(clearAppSession).toHaveBeenCalledTimes(1));
      expect(dispatch).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('shows the generic message when the leftover sign-in cannot be dropped', async () => {
      signInWithRedirect.mockRejectedValue(alreadySignedIn);
      checkAppSession.mockResolvedValue({ status: 'unauthorized' });
      clearAppSession.mockRejectedValue(new Error('provider unreachable'));
      renderLogin('ready');
      submit();
      expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in could not begin. Please retry or contact your administrator.');
      expect(clearAppSession).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: /sign in with google/i })).toBeEnabled();
    });

    it('says the service is unreachable, without signing anything out, when the API cannot answer', async () => {
      signInWithRedirect.mockRejectedValue(alreadySignedIn);
      checkAppSession.mockResolvedValue({ status: 'unavailable' });
      renderLogin('ready');
      submit();
      expect(await screen.findByRole('alert')).toHaveTextContent('Alcántara is not reachable right now. Wait a moment and try again.');
      expect(clearAppSession).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /sign in with google/i })).toBeEnabled();
    });

    it('still shows the generic message for any other sign-in failure', async () => {
      signInWithRedirect.mockRejectedValue(new Error('popup blocked'));
      renderLogin('ready');
      submit();
      expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in could not begin. Please retry or contact your administrator.');
      expect(checkAppSession).not.toHaveBeenCalled();
    });
  });
});

describe('login desktop change without an error', () => {
  afterEach(() => {
    desktop.host = null;
  });

  it('keeps the form ready when the desktop reports a successful change', () => {
    const listeners: Array<(change: { signedIn: boolean; error: string | null }) => void> = [];
    const auth = {
      currentSession: vi.fn(),
      signIn: vi.fn(async () => undefined),
      signOut: vi.fn(),
      onChange: vi.fn((listener: (change: { signedIn: boolean; error: string | null }) => void) => {
        listeners.push(listener);
        return vi.fn();
      }),
    };
    desktop.host = { auth };
    renderLogin('ready');
    listeners[0]({ signedIn: true, error: null });
    expect(screen.queryByText('Sign-in could not begin. Please retry or contact your administrator.')).toBeNull();
    expect(screen.getByRole('button', { name: /sign in with google/i })).toBeEnabled();
  });
});
