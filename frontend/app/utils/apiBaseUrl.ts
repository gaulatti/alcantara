export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  (import.meta.env.DEV ? 'http://localhost:3000' : undefined);

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