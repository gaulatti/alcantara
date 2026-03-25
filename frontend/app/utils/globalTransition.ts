import { useCallback, useEffect, useState } from 'react';

const DEFAULT_TRANSITION_ID = 'crescendo-prism';
const GLOBAL_TRANSITION_STORAGE_KEY = 'alcantara.globalTransitionId';
const GLOBAL_TRANSITION_EVENT = 'alcantara:global-transition-change';

interface GlobalTransitionEventDetail {
  transitionId: string;
}

function normalizeTransitionId(transitionId: string | null | undefined): string {
  const normalized = (transitionId || '').trim();
  return normalized || DEFAULT_TRANSITION_ID;
}

function readStoredTransitionId(): string {
  if (typeof window === 'undefined') {
    return DEFAULT_TRANSITION_ID;
  }

  return normalizeTransitionId(window.localStorage.getItem(GLOBAL_TRANSITION_STORAGE_KEY));
}

export function useGlobalTransitionId() {
  const [transitionId, setTransitionIdState] = useState<string>(DEFAULT_TRANSITION_ID);

  useEffect(() => {
    setTransitionIdState(readStoredTransitionId());
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== GLOBAL_TRANSITION_STORAGE_KEY) {
        return;
      }

      setTransitionIdState(normalizeTransitionId(event.newValue));
    };

    const handleGlobalTransitionChange = (event: Event) => {
      const customEvent = event as CustomEvent<GlobalTransitionEventDetail>;
      setTransitionIdState(normalizeTransitionId(customEvent.detail?.transitionId));
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener(GLOBAL_TRANSITION_EVENT, handleGlobalTransitionChange);

    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(GLOBAL_TRANSITION_EVENT, handleGlobalTransitionChange);
    };
  }, []);

  const setTransitionId = useCallback((nextTransitionId: string) => {
    const normalized = normalizeTransitionId(nextTransitionId);
    setTransitionIdState(normalized);

    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(GLOBAL_TRANSITION_STORAGE_KEY, normalized);
    window.dispatchEvent(
      new CustomEvent<GlobalTransitionEventDetail>(GLOBAL_TRANSITION_EVENT, {
        detail: { transitionId: normalized }
      })
    );
  }, []);

  return [transitionId, setTransitionId] as const;
}
