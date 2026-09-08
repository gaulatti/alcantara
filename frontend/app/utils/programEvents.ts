import type { ProgramTemplateManifest } from './programTemplate';

export const PROGRAMS_CHANGED_EVENT = 'alcantara:programs-changed';

export interface ProgramSummary {
  programId: string;
  type?: 'tv' | 'radio' | 'both';
  templateManifest?: ProgramTemplateManifest | null;
}

export function notifyProgramsChanged(programs: ProgramSummary[]): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<ProgramSummary[]>(PROGRAMS_CHANGED_EVENT, {
      detail: programs
    })
  );
}
