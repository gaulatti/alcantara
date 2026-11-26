import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../services/api';

export type FeatureLevel = 'C' | 'T1' | 'T2' | 'T3';

export interface UserContext {
  features?: Record<string, { level: FeatureLevel }>;
  membership?: any;
  authorization?: {
    permissions?: string[];
    roles?: string[];
    teamId?: number;
  };
}

interface FeaturesContextValue {
  context: UserContext | null;
  loading: boolean;
  hasPermission: (permission: string) => boolean;
}

const FeaturesContext = createContext<FeaturesContextValue>({
  context: null,
  loading: true,
  hasPermission: () => false
});

export const useFeatures = () => useContext(FeaturesContext);

// const levelValues: Record<FeatureLevel, number> = { C: 0, T1: 1, T2: 2, T3: 3 };

export function FeaturesProvider({ children }: { children: ReactNode }) {
  const [context, setContext] = useState<UserContext | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    api
      .get('/auth/me')
      .then((res) => {
        if (mounted) {
          setContext(res.data || {});
          setLoading(false);
        }
      })
      .catch((err) => {
        console.error('Failed to load user context', err);
        if (mounted) {
          setContext(null);
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  const hasPermission = (permission: string): boolean => {
    const permissions = context?.authorization?.permissions ?? [];
    return permissions.includes('*') || permissions.includes(permission);
  };

  return <FeaturesContext.Provider value={{ context, loading, hasPermission }}>{children}</FeaturesContext.Provider>;
}

export function Can({ children }: { children: ReactNode }) {
  const { loading } = useFeatures();

  if (loading) return null;

  return <>{children}</>;
}
