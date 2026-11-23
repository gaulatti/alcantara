import React from 'react';
import { cleanup, render, screen, configure } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

// These tests import the packaged scenes after resetting the module registry, which is slow on a loaded
// CI runner: wait for the lazy load for as long as it takes rather than a fixed second.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 15_000 });

afterEach(() => {
  cleanup();
  vi.doUnmock('@modoitaliano/giorgia/scenes');
  vi.resetModules();
});

it('renders the packaged podcast player with the props it is given when the package exports it', async () => {
  const Stub = vi.fn((_props: Record<string, unknown>) => <div data-testid='packaged-player' />);
  vi.doMock('@modoitaliano/giorgia/scenes', () => ({ ModoItalianoGiorgiaPodcastPlayer: Stub }));
  const { GiorgiaPodcastPlayerRenderer } = await import('./GiorgiaPodcastPlayerRenderer');
  render(<GiorgiaPodcastPlayerRenderer episodeTitle='Ep 1' showName='Show' audioUrl='/a.mp3' masterGain={0.5} />);
  expect(await screen.findByTestId('packaged-player')).toBeTruthy();
  expect(Stub.mock.calls[0][0]).toMatchObject({ episodeTitle: 'Ep 1', showName: 'Show', audioUrl: '/a.mp3', masterGain: 0.5 });
});

it('renders the local podcast player when the package does not export it', async () => {
  vi.doMock('@modoitaliano/giorgia/scenes', () => ({}));
  const { GiorgiaPodcastPlayerRenderer } = await import('./GiorgiaPodcastPlayerRenderer');
  const view = render(<GiorgiaPodcastPlayerRenderer episodeTitle='Una puntata' showName='Modo Italiano' />);
  expect((await view.findByRole('heading')).textContent).toBe('Una puntata');
});
