import React from 'react';
import { cleanup, render, screen, configure } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchSongCatalog } from '../services/songs';

// These tests import the packaged scenes after resetting the module registry, which is slow on a loaded
// CI runner: wait for the lazy load for as long as it takes rather than a fixed second.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 15_000 });

vi.mock('../services/songs', () => ({ fetchSongCatalog: vi.fn().mockResolvedValue([]) }));

const props = { title: 'TORNEO' } as unknown as React.ComponentProps<typeof import('./GiorgiaLegacyBracketRenderer').GiorgiaLegacyBracketRenderer>;

afterEach(() => {
  cleanup();
  vi.doUnmock('@modoitaliano/giorgia/scenes/legacy');
  vi.resetModules();
});

it('renders the packaged legacy bracket with its props when the package exports it', async () => {
  const Stub = vi.fn((_props: Record<string, unknown>) => <div data-testid='packaged' />);
  vi.doMock('@modoitaliano/giorgia/scenes/legacy', () => ({ ModoItalianoBracket: Stub }));
  const { GiorgiaLegacyBracketRenderer } = await import('./GiorgiaLegacyBracketRenderer');
  render(<GiorgiaLegacyBracketRenderer {...props} />);
  expect(await screen.findByTestId('packaged')).toBeTruthy();
  const received = Stub.mock.calls[0][0] as Record<string, unknown>;
  expect(received).toMatchObject(props as unknown as Record<string, unknown>);
  expect(received.loadSongCatalog).toBe(fetchSongCatalog);
});

it('renders the local bracket when the package does not export it', async () => {
  vi.doMock('@modoitaliano/giorgia/scenes/legacy', () => ({}));
  const { GiorgiaLegacyBracketRenderer } = await import('./GiorgiaLegacyBracketRenderer');
  const view = render(<GiorgiaLegacyBracketRenderer {...props} />);
  expect(await view.findByText('Gran Final')).toBeTruthy();
});
