import React from 'react';
import { cleanup, render, screen, waitFor, configure } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

// These tests import the packaged scenes after resetting the module registry, which is slow on a loaded
// CI runner: wait for the lazy load for as long as it takes rather than a fixed second.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 15_000 });

const props = { show: true } as unknown as React.ComponentProps<typeof import('./GiorgiaLegacyPodcastPlayerRenderer').GiorgiaLegacyPodcastPlayerRenderer>;

afterEach(() => {
  cleanup();
  vi.doUnmock('@modoitaliano/giorgia/scenes/legacy');
  vi.resetModules();
});

it('renders the packaged legacy podcastplayer with its props when the package exports it', async () => {
  const Stub = vi.fn((_props: Record<string, unknown>) => <div data-testid='packaged' />);
  vi.doMock('@modoitaliano/giorgia/scenes/legacy', () => ({ ModoItalianoPodcastPlayer: Stub }));
  const { GiorgiaLegacyPodcastPlayerRenderer } = await import('./GiorgiaLegacyPodcastPlayerRenderer');
  render(<GiorgiaLegacyPodcastPlayerRenderer {...props} />);
  expect(await screen.findByTestId('packaged')).toBeTruthy();
  const received = Stub.mock.calls[0][0] as Record<string, unknown>;
  expect(received).toMatchObject(props as unknown as Record<string, unknown>);
});

it('renders the local podcastplayer when the package does not export it', async () => {
  vi.doMock('@modoitaliano/giorgia/scenes/legacy', () => ({}));
  const { GiorgiaLegacyPodcastPlayerRenderer } = await import('./GiorgiaLegacyPodcastPlayerRenderer');
  const view = render(<GiorgiaLegacyPodcastPlayerRenderer {...props} />);
  await waitFor(() => expect(view.container.firstChild).not.toBeNull());
});
