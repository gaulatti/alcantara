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

const textSequence = { mode: 'manual', items: [{ id: 'a', text: 'Ciao mondo' }], activeItemId: 'a' };

it('renders the packaged chyron with the props it is given when the package exports it', async () => {
  const Stub = vi.fn((_props: Record<string, unknown>) => <div data-testid='packaged-chyron' />);
  vi.doMock('@modoitaliano/giorgia/scenes', () => ({ ModoItalianoGiorgiaChyron: Stub }));
  const { GiorgiaChyronRenderer } = await import('./GiorgiaChyronRenderer');
  render(<GiorgiaChyronRenderer show textSequence={textSequence} keySafe />);
  expect(await screen.findByTestId('packaged-chyron')).toBeTruthy();
  expect(Stub.mock.calls[0][0]).toMatchObject({ show: true, textSequence, keySafe: true });
});

it('renders the local chyron when the package does not export it', async () => {
  vi.doMock('@modoitaliano/giorgia/scenes', () => ({}));
  const { GiorgiaChyronRenderer } = await import('./GiorgiaChyronRenderer');
  const view = render(<GiorgiaChyronRenderer show textSequence={textSequence} />);
  expect((await view.findByRole('heading')).textContent).toBe('CIAO MONDO');
});
