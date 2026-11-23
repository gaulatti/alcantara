import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authStatus, dispatch, checkAppSession, clearAppSession } = vi.hoisted(() => ({
  authStatus: { isAuthenticated: false, isLoaded: false },
  dispatch: vi.fn(),
  checkAppSession: vi.fn(),
  clearAppSession: vi.fn(),
}));
vi.mock('react-redux', () => ({ useDispatch: () => dispatch }));
vi.mock('../../hooks/useAuth', () => ({ useAuthStatus: () => authStatus }));
vi.mock('../../services/sessionCheck', () => ({ checkAppSession }));
vi.mock('../../services/session', () => ({ clearAppSession }));
// gaulatti/alcantara#431: no desktop host unless a test plugs one in.
const desktop = vi.hoisted(() => ({ host: null as null | Record<string, unknown> }));
vi.mock('@desktop-host', () => ({
  get default() {
    return desktop.host;
  },
}));


import { SESSION_INVALID_EVENT } from '../../services/session-events';
import AuthListener, { SESSION_RETRY_MS } from './AuthListener';

const user = { id: 'sub-1', principalId: 'p-1', email: 'a@example.test' };
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('AuthListener', () => {
  beforeEach(() => {
    authStatus.isLoaded = false;
    dispatch.mockReset();
    checkAppSession.mockReset();
    clearAppSession.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    desktop.host = null;
  });

  it('checks the session again when a desktop app signs in, signs out on its sign-out, and unsubscribes', async () => {
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
    authStatus.isLoaded = true;
    checkAppSession.mockResolvedValue({ status: 'signed-in', user });
    const view = render(<AuthListener />);
    expect(auth.onChange).toHaveBeenCalledTimes(1);
    expect(checkAppSession).not.toHaveBeenCalled();
    await act(async () => listeners[0]({ signedIn: true, error: null }));
    await flush();
    expect(dispatch).toHaveBeenCalledWith({ type: 'LOGIN', payload: user });
    dispatch.mockReset();
    act(() => listeners[0]({ signedIn: false, error: null }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'LOGOUT' });
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('signs in when the session checks out', async () => {
    checkAppSession.mockResolvedValue({ status: 'signed-in', user });
    render(<AuthListener />);
    await flush();
    expect(dispatch).toHaveBeenCalledWith({ type: 'LOGIN', payload: user });
  });

  it('marks the user signed out when the provider has no session', async () => {
    checkAppSession.mockResolvedValue({ status: 'signed-out' });
    render(<AuthListener />);
    await flush();
    expect(dispatch).toHaveBeenCalledWith({ type: 'LOGOUT' });
    expect(clearAppSession).not.toHaveBeenCalled();
  });

  it('keeps waiting and asks again while the API is unreachable, without signing out', async () => {
    vi.useFakeTimers();
    checkAppSession.mockResolvedValueOnce({ status: 'unavailable' }).mockResolvedValueOnce({ status: 'unavailable' }).mockResolvedValue({ status: 'signed-in', user });
    render(<AuthListener />);
    await flush();
    expect(dispatch).not.toHaveBeenCalled();
    expect(checkAppSession).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(SESSION_RETRY_MS); });
    await flush();
    expect(checkAppSession).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(SESSION_RETRY_MS); });
    await flush();
    expect(dispatch).toHaveBeenCalledWith({ type: 'LOGIN', payload: user });
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'LOGOUT' });
    expect(clearAppSession).not.toHaveBeenCalled();
  });

  it('clears the provider session too when the API rejects it', async () => {
    checkAppSession.mockResolvedValue({ status: 'unauthorized' });
    clearAppSession.mockResolvedValue(undefined);
    render(<AuthListener />);
    await flush();
    await flush();
    expect(clearAppSession).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: 'LOGOUT' });
  });

  it('stops retrying once unmounted', async () => {
    vi.useFakeTimers();
    checkAppSession.mockResolvedValue({ status: 'unavailable' });
    const { unmount } = render(<AuthListener />);
    await flush();
    unmount();
    await act(async () => { vi.advanceTimersByTime(SESSION_RETRY_MS * 3); });
    expect(checkAppSession).toHaveBeenCalledTimes(1);
  });

  it('does not check again once the session is loaded, but still reacts to an invalid-session report', async () => {
    authStatus.isLoaded = true;
    render(<AuthListener />);
    await flush();
    expect(checkAppSession).not.toHaveBeenCalled();
    act(() => { window.dispatchEvent(new Event(SESSION_INVALID_EVENT)); });
    expect(dispatch).toHaveBeenCalledWith({ type: 'LOGOUT' });
  });

  it('does not mark the user signed out when it unmounts while the rejected sign-in is being cleared', async () => {
    let finish!: () => void;
    checkAppSession.mockResolvedValue({ status: 'unauthorized' });
    clearAppSession.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const view = render(<AuthListener />);
    await flush();
    view.unmount();
    dispatch.mockClear();
    await act(async () => finish());
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('ignores a session answer that arrives after it unmounts', async () => {
    let answer!: (v: unknown) => void;
    checkAppSession.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const view = render(<AuthListener />);
    view.unmount();
    await act(async () => answer({ status: 'signed-in', user }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('logs a failure to clear the rejected sign-in and still signs the user out', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    checkAppSession.mockResolvedValue({ status: 'unauthorized' });
    clearAppSession.mockRejectedValue(new Error('amplify'));
    render(<AuthListener />);
    await flush();
    await flush();
    expect(error).toHaveBeenCalledWith('Could not clear the rejected sign-in:', expect.any(Error));
    expect(dispatch).toHaveBeenCalledWith({ type: 'LOGOUT' });
  });
});
