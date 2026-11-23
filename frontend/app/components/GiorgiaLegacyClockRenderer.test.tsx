import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getProgramAudioBusSnapshot, subscribeProgramAudioBus } from '../utils/programAudioBus';

const props = { programId: 'main' } as unknown as React.ComponentProps<typeof import('./GiorgiaLegacyClockRenderer').GiorgiaLegacyClockRenderer>;

afterEach(() => {
  cleanup();
  vi.doUnmock('@modoitaliano/giorgia/scenes/legacy');
  vi.resetModules();
});

it('renders the packaged legacy clock with its props when the package exports it', async () => {
  const Stub = vi.fn((_props: Record<string, unknown>) => <div data-testid='packaged' />);
  vi.doMock('@modoitaliano/giorgia/scenes/legacy', () => ({ ModoItalianoClock: Stub }));
  const { GiorgiaLegacyClockRenderer } = await import('./GiorgiaLegacyClockRenderer');
  render(<GiorgiaLegacyClockRenderer {...props} />);
  expect(await screen.findByTestId('packaged')).toBeTruthy();
  const received = Stub.mock.calls[0][0] as Record<string, unknown>;
  expect(received).toMatchObject(props as unknown as Record<string, unknown>);
  expect(received.audioBus).toEqual({ getSnapshot: getProgramAudioBusSnapshot, subscribe: subscribeProgramAudioBus });
});

it('renders the local clock when the package does not export it', async () => {
  vi.doMock('@modoitaliano/giorgia/scenes/legacy', () => ({}));
  const { GiorgiaLegacyClockRenderer } = await import('./GiorgiaLegacyClockRenderer');
  const view = render(<GiorgiaLegacyClockRenderer {...props} />);
  expect(await view.findByText(/\d{2}:\d{2}/)).toBeTruthy();
});
