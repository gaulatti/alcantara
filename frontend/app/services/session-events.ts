export const SESSION_INVALID_EVENT = 'alcantara:session-invalid';

export const reportInvalidSession = (): void => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(SESSION_INVALID_EVENT));
  }
};
