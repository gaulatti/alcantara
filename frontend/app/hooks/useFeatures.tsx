import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../../services/api';

export type FeatureLevel = 'C' | 'T1' | 'T2' | 'T3';

export interface UserContext {
  features?: Record<string, { level: FeatureLevel }>;
  membership?: any;
}

interface FeaturesContextValue {
  context: UserContext | null;
  loading: boolean;
  hasFeature: (slug: string, minLevel?: FeatureLevel) => boolean;
}

const FeaturesContext = createContext<FeaturesContextValue>({
  context: null,
  loading: true,
  hasFeature: () => false,
});

export const useFeatures = () => useContext(FeaturesContext);

const levelValues: Record<FeatureLevel, number> = { C: 0, T1: 1, T2: 2, T3: 3 };

export function FeaturesProvider({ children }: { children: ReactNode }) {
  const [context, setContext] = useState<UserContext | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    api.get('/auth/me')
      .then((res) => {
        if (mounted) {
          setContext(res.data.context || {});
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

    return () => { mounted = false; };
  }, []);

  const hasFeature = (slug: string, minLevel: FeatureLevel = 'C'): boolean => {
    if (!context?.features || !context.features[slug]) {
      return false;
    }
    const userLevel = context.features[slug].level;
    return (levelValues[userLevel] ?? -1) >= levelValues[minLevel];
  };

  return (
    <FeaturesContext.Provider value={{ context, loading, hasFeature }}>
      {children}
    </FeaturesContext.Provider>
  );
}

export function Can({ feature, level = 'C', children, fallback = null }: { feature: string; level?: FeatureLevel; children: ReactNode; fallback?: ReactNode }) {
  const { hasFeature, loading } = useFeatures();

  if (loading) return null;

  return hasFeature(feature, level) ? <>{children}</> : <>{fallback}</>;
}
