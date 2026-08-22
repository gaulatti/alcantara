import axios from 'axios';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../services/api';

export interface AuthorizationContext {
  permissions: string[];
  roles: string[];
  teamId: number;
}

type AuthorizationStatus = 'loading' | 'ready' | 'unauthenticated' | 'denied' | 'unavailable';

interface FeaturesContextValue {
  context: AuthorizationContext | null;
  status: AuthorizationStatus;
  hasPermission: (permission: string) => boolean;
  reload: () => void;
}

const FeaturesContext = createContext<FeaturesContextValue>({
  context: null,
  status: 'loading',
  hasPermission: () => false,
  reload: () => undefined
});

export const useFeatures = () => useContext(FeaturesContext);

export function FeaturesProvider({ children }: { children: ReactNode }) {
  const [context, setContext] = useState<AuthorizationContext | null>(null);
  const [status, setStatus] = useState<AuthorizationStatus>('loading');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setStatus('loading');
    void api.get<{ authorization?: AuthorizationContext }>('/auth/me').then((response) => {
      if (!active) return;
      const authorization = response.data.authorization ?? null;
      setContext(authorization);
      setStatus(authorization ? 'ready' : 'denied');
    }).catch((error: unknown) => {
      if (!active) return;
      setContext(null);
      const code = axios.isAxiosError(error) ? error.response?.status : undefined;
      setStatus(code === 401 ? 'unauthenticated' : code === 403 ? 'denied' : 'unavailable');
    });
    return () => { active = false; };
  }, [revision]);

  const hasPermission = useCallback((permission: string) => (
    context?.permissions.includes('*') === true || context?.permissions.includes(permission) === true
  ), [context]);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  return <FeaturesContext.Provider value={{ context, status, hasPermission, reload }}>{children}</FeaturesContext.Provider>;
}

export function Can({ permission, children, fallback = null }: { permission: string; children: ReactNode; fallback?: ReactNode }) {
  const { status, hasPermission } = useFeatures();
  if (status !== 'ready') return null;
  return hasPermission(permission) ? <>{children}</> : <>{fallback}</>;
}
