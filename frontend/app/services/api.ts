import axios, { AxiosError } from 'axios';
import { apiUrl, getApiBaseUrl } from '../utils/apiBaseUrl';
import { reportInvalidSession } from './session-events';
import { getAppSession } from './session';

export const api = axios.create({
  baseURL: getApiBaseUrl(),
  headers: {
    'Content-Type': 'application/json'
  }
});

api.interceptors.request.use(
  async (config) => {
    try {
      const session = await getAppSession();
      const token = session.token;
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    } catch {
      // no-op for unauthenticated/public calls
    }
    return config;
  },
  (error) => Promise.reject(error)
);

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const request = error.config as
      | (NonNullable<AxiosError['config']> & { _authRetry?: boolean })
      | undefined;
    if (error.response?.status !== 401 || !request || request._authRetry) {
      if (error.response?.status === 401) reportInvalidSession();
      return Promise.reject(error);
    }

    request._authRetry = true;
    try {
      const refreshed = await getAppSession(true);
      const token = refreshed.token;
      if (!token) throw new Error('Refreshed session has no ID token');
      request.headers.set('Authorization', `Bearer ${token}`);
      return await api.request(request);
    } catch (refreshError) {
      reportInvalidSession();
      return Promise.reject(refreshError);
    }
  }
);

export const authFetch = async (input: string, init?: RequestInit): Promise<Response> => {
  const headers = new Headers(init?.headers);

  try {
    const session = await getAppSession();
    const token = session.token;
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  } catch {
    // no-op
  }

  return fetch(apiUrl(input), {
    ...init,
    headers
  });
};

export const handleApiError = (error: unknown): string => {
  if (axios.isAxiosError(error)) {
    if (error.response?.data?.error) {
      return error.response.data.error;
    }
    if (error.response?.status === 404) {
      return 'Resource not found';
    }
    if (error.response?.status === 403) {
      return 'Access denied';
    }
    if (error.response?.status === 500) {
      return 'Server error. Please try again later.';
    }
    return error.message;
  }
  return 'An unexpected error occurred';
};
