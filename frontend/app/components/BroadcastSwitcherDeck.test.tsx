import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BroadcastSwitcherDeck } from './BroadcastSwitcherDeck';

vi.mock('../contexts/ConsolePreferencesContext', () => ({ useConsolePreferences: () => ({ profile: { touchMode: false, shortcutsEnabled: false, dockWidth: 280 }, updateProfile: vi.fn(), syncState: 'synced', deviceClass: 'desktop' }) }));
vi.mock('../hooks/useFeatures', () => ({ useFeatures: () => ({ context: {} }) }));
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const scene = { id: 1, name: 'Editable scene' } as any;
const props = { programId: 'test', activeScene: scene, stagedScene: scene, scenes: [scene], transitionId: 'cut', realtimeConnected: true, onWorkspaceChange: vi.fn(), onTransitionChange: vi.fn(), onStageScene: vi.fn(), onTake: vi.fn(), onCut: vi.fn(), onFadeToBlack: vi.fn() };
it('reserves Audio for audio tools with only a small program monitor', () => {
  render(<BroadcastSwitcherDeck {...props} workspace='audio' />);
  expect(screen.getByTitle('PROGRAM confidence monitor')).toBeInTheDocument();
  expect(screen.queryByTitle('PREVIEW confidence monitor')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Assigned scenes')).not.toBeInTheDocument();
  expect(screen.queryByText('SWITCHER')).not.toBeInTheDocument();
});
it.each(['director', 'graphics'] as const)('retains bounded previews and scene selection in %s', workspace => {
  render(<BroadcastSwitcherDeck {...props} workspace={workspace} />);
  expect(screen.getByTitle('PREVIEW confidence monitor')).toBeInTheDocument();
  expect(screen.getByLabelText('Assigned scenes')).toHaveClass('overflow-y-auto', 'max-h-36');
  expect(screen.getByRole('button', { name: /Editable scene/ })).toBeInTheDocument();
});
