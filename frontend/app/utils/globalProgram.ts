import { useCallback, useEffect, useState } from 'react';

const DEFAULT_PROGRAM_ID = 'main';
const GLOBAL_PROGRAM_STORAGE_KEY = 'alcantara.globalProgramId';
const GLOBAL_PROGRAM_EVENT = 'alcantara:global-program-change';

interface GlobalProgramEventDetail {
  programId: string;
}

function normalizeProgramId(programId: string | null | undefined): string {
  const normalized = (programId || '').trim();
  return normalized || DEFAULT_PROGRAM_ID;
}

function readStoredProgramId(): string {
  if (typeof window === 'undefined') {
    return DEFAULT_PROGRAM_ID;
  }

  return normalizeProgramId(window.localStorage.getItem(GLOBAL_PROGRAM_STORAGE_KEY));
}

export function useGlobalProgramId() {
  const [programId, setProgramIdState] = useState<string>(() => readStoredProgramId());

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== GLOBAL_PROGRAM_STORAGE_KEY) {
        return;
      }

      setProgramIdState(normalizeProgramId(event.newValue));
    };

    const handleGlobalProgramChange = (event: Event) => {
      const customEvent = event as CustomEvent<GlobalProgramEventDetail>;
      setProgramIdState(normalizeProgramId(customEvent.detail?.programId));
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener(GLOBAL_PROGRAM_EVENT, handleGlobalProgramChange);

    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(GLOBAL_PROGRAM_EVENT, handleGlobalProgramChange);
    };
  }, []);

  const setProgramId = useCallback((nextProgramId: string) => {
    const normalized = normalizeProgramId(nextProgramId);
    setProgramIdState(normalized);

    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(GLOBAL_PROGRAM_STORAGE_KEY, normalized);
    window.dispatchEvent(
      new CustomEvent<GlobalProgramEventDetail>(GLOBAL_PROGRAM_EVENT, {
        detail: { programId: normalized }
      })
    );
  }, []);

  return [programId, setProgramId] as const;
}
