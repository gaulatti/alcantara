import { afterEach, expect, it, vi } from 'vitest';
import { reportInvalidSession, SESSION_INVALID_EVENT } from './session-events';

afterEach(() => vi.unstubAllGlobals());

it('notifies browser session consumers using the agreed invalidation event', () => {
  const listener = vi.fn();
  window.addEventListener(SESSION_INVALID_EVENT, listener);
  try {
    reportInvalidSession();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0]).toBeInstanceOf(Event);
  } finally {
    window.removeEventListener(SESSION_INVALID_EVENT, listener);
  }
});

it('can report invalidation during server rendering without requiring a browser', () => {
  vi.stubGlobal('window', undefined);
  expect(() => reportInvalidSession()).not.toThrow();
});
