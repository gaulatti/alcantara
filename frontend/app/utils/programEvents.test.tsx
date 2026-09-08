import { describe, expect, it, vi } from 'vitest';
import { notifyProgramsChanged, PROGRAMS_CHANGED_EVENT, type ProgramSummary } from './programEvents';

describe('program change events', () => {
  it('publishes the refreshed program list to shell consumers', () => {
    const programs: ProgramSummary[] = [
      { programId: 'main', templateManifest: null },
      { programId: 'fifthbell', templateManifest: null }
    ];
    const listener = vi.fn();
    window.addEventListener(PROGRAMS_CHANGED_EVENT, listener);

    notifyProgramsChanged(programs);

    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual(programs);
    window.removeEventListener(PROGRAMS_CHANGED_EVENT, listener);
  });
});
