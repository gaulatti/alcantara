function formatHostForUrl(hostname: string): string {
  if (!hostname) {
    return '127.0.0.1';
  }

  // Bracket IPv6 hosts when building URLs like http://[::1]:3000
  return hostname.includes(':') ? `[${hostname}]` : hostname;
}

function getDevDefaultApiBaseUrl(): string {
  if (typeof window === 'undefined') {
    return 'http://127.0.0.1:3000';
  }

  const host = formatHostForUrl(window.location.hostname);
  return `http://${host}:3000`;
}

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? getDevDefaultApiBaseUrl() : undefined);

export function getApiBaseUrl(): string {
  if (!API_BASE_URL) {
    throw new Error('VITE_API_BASE_URL must be set for frontend API requests.');
  }

  return API_BASE_URL.replace(/\/$/, '');
}

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${getApiBaseUrl()}${normalizedPath}`;
}
