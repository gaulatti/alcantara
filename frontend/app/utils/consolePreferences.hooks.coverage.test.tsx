import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const preferences = vi.hoisted(() => ({
  profile: { selectedProgramId: 'main', transitions: {} as Record<string, string> },
  updateProfile: vi.fn(),
}));
vi.mock('../contexts/ConsolePreferencesContext', () => ({
  useConsolePreferences: () => preferences,
}));

import { useGlobalProgramId } from './globalProgram';
import { useGlobalTransitionId } from './globalTransition';

beforeEach(() => {
  preferences.profile = { selectedProgramId: 'evening', transitions: { evening: 'soft-cut' } };
  preferences.updateProfile = vi.fn();
});

describe('the operator selected program', () => {
  it('reads the saved program and saves a trimmed choice, falling back to main when blank', () => {
    const { result } = renderHook(() => useGlobalProgramId());
    expect(result.current[0]).toBe('evening');
    act(() => result.current[1]('  late-show  '));
    expect(preferences.updateProfile).toHaveBeenLastCalledWith({ selectedProgramId: 'late-show' });
    act(() => result.current[1]('   '));
    expect(preferences.updateProfile).toHaveBeenLastCalledWith({ selectedProgramId: 'main' });
  });
});

describe('the per-program transition', () => {
  it('reads the saved transition for the program and keeps the others when one changes', () => {
    preferences.profile.transitions = { evening: 'soft-cut', main: 'wipe' };
    const { result } = renderHook(() => useGlobalTransitionId(' evening '));
    expect(result.current[0]).toBe('soft-cut');
    act(() => result.current[1](' flash '));
    expect(preferences.updateProfile).toHaveBeenLastCalledWith({
      transitions: { evening: 'flash', main: 'wipe' },
    });
    act(() => result.current[1]('  '));
    expect(preferences.updateProfile).toHaveBeenLastCalledWith({
      transitions: { evening: 'crescendo-prism', main: 'wipe' },
    });
  });

  it('uses the default transition and the main program when nothing is saved or the id is blank', () => {
    preferences.profile.transitions = {};
    expect(renderHook(() => useGlobalTransitionId('  ')).result.current[0]).toBe('crescendo-prism');
    expect(renderHook(() => useGlobalTransitionId()).result.current[0]).toBe('crescendo-prism');
  });
});
