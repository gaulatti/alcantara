import { useCallback, useEffect, useState } from 'react';

const DEFAULT_TRANSITION_ID = 'crescendo-prism';
const LEGACY_GLOBAL_TRANSITION_STORAGE_KEY = 'alcantara.globalTransitionId';
const PROGRAM_TRANSITION_STORAGE_KEY_PREFIX = 'alcantara.programTransitionId.';
const GLOBAL_TRANSITION_EVENT = 'alcantara:global-transition-change';
const DEFAULT_PROGRAM_ID = 'main';

interface GlobalTransitionEventDetail {
  programId: string;
  transitionId: string;
}

function normalizeTransitionId(transitionId: string | null | undefined): string {
  const normalized = (transitionId || '').trim();
  return normalized || DEFAULT_TRANSITION_ID;
}

function normalizeProgramId(programId: string | null | undefined): string {
  const normalized = (programId || '').trim();
  return normalized || DEFAULT_PROGRAM_ID;
}

function getProgramTransitionStorageKey(programId: string): string {
  return `${PROGRAM_TRANSITION_STORAGE_KEY_PREFIX}${normalizeProgramId(programId)}`;
}

function readStoredTransitionId(programId: string): string {
  if (typeof window === 'undefined') {
    return DEFAULT_TRANSITION_ID;
  }

  const scopedKey = getProgramTransitionStorageKey(programId);
  const scopedValue = window.localStorage.getItem(scopedKey);
  if (typeof scopedValue === 'string' && scopedValue.trim()) {
    return normalizeTransitionId(scopedValue);
  }

  return normalizeTransitionId(window.localStorage.getItem(LEGACY_GLOBAL_TRANSITION_STORAGE_KEY));
}

export function useGlobalTransitionId(programId?: string) {
  const normalizedProgramId = normalizeProgramId(programId);
  const [transitionId, setTransitionIdState] = useState<string>(() => readStoredTransitionId(normalizedProgramId));

  useEffect(() => {
    setTransitionIdState(readStoredTransitionId(normalizedProgramId));
  }, [normalizedProgramId]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (
        event.key !== getProgramTransitionStorageKey(normalizedProgramId) &&
        event.key !== LEGACY_GLOBAL_TRANSITION_STORAGE_KEY
      ) {
        return;
      }

      setTransitionIdState(readStoredTransitionId(normalizedProgramId));
    };

    const handleGlobalTransitionChange = (event: Event) => {
      const customEvent = event as CustomEvent<GlobalTransitionEventDetail>;
      if (normalizeProgramId(customEvent.detail?.programId) !== normalizedProgramId) {
        return;
      }
      setTransitionIdState(normalizeTransitionId(customEvent.detail?.transitionId));
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener(GLOBAL_TRANSITION_EVENT, handleGlobalTransitionChange);

    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(GLOBAL_TRANSITION_EVENT, handleGlobalTransitionChange);
    };
  }, [normalizedProgramId]);

  const setTransitionId = useCallback((nextTransitionId: string) => {
    const normalized = normalizeTransitionId(nextTransitionId);
    setTransitionIdState(normalized);

    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(getProgramTransitionStorageKey(normalizedProgramId), normalized);
    window.dispatchEvent(
      new CustomEvent<GlobalTransitionEventDetail>(GLOBAL_TRANSITION_EVENT, {
        detail: {
          programId: normalizedProgramId,
          transitionId: normalized
        }
      })
    );
  }, [normalizedProgramId]);

  return [transitionId, setTransitionId] as const;
}
