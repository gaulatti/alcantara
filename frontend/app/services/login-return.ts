const RETURN_TO_KEY = 'alcantara:login:return-to';
const REDIRECT_STARTED_KEY = 'alcantara:login:redirect-started';

export function loginPathForLocation(pathname: string, search: string, hash: string): string {
  const returnTo = `${pathname}${search}${hash}`;
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export function safeReturnPath(value: string | null): string {
  if (!value) return '/';
  try {
    const target = new URL(value, window.location.origin);
    if (target.origin !== window.location.origin) return '/';
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return '/';
  }
}

export function returnPathFromSearch(search: string): string {
  return safeReturnPath(new URLSearchParams(search).get('returnTo'));
}

export function prepareLoginRedirect(search: string): boolean {
  sessionStorage.setItem(RETURN_TO_KEY, returnPathFromSearch(search));
  if (sessionStorage.getItem(REDIRECT_STARTED_KEY) === '1') return false;
  sessionStorage.setItem(REDIRECT_STARTED_KEY, '1');
  return true;
}

export function cancelLoginRedirect(): void {
  sessionStorage.removeItem(REDIRECT_STARTED_KEY);
}

export function takeLoginReturnPath(): string | null {
  const value = sessionStorage.getItem(RETURN_TO_KEY);
  sessionStorage.removeItem(RETURN_TO_KEY);
  sessionStorage.removeItem(REDIRECT_STARTED_KEY);
  return value ? safeReturnPath(value) : null;
}
