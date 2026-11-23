import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getProgramAudioBusSnapshot, subscribeProgramAudioBus } from '../utils/programAudioBus';

afterEach(() => {
  cleanup();
  vi.doUnmock('@modoitaliano/giorgia/scenes');
  vi.resetModules();
});

it('renders the packaged clock with its props and with this app’s audio bus', async () => {
  const Stub = vi.fn((_props: Record<string, unknown>) => <div data-testid='packaged-clock' />);
  vi.doMock('@modoitaliano/giorgia/scenes', () => ({ ModoItalianoGiorgiaClock: Stub }));
  const { GiorgiaClockRenderer } = await import('./GiorgiaClockRenderer');
  render(<GiorgiaClockRenderer programId='main' part='header' keySafe />);
  expect(await screen.findByTestId('packaged-clock')).toBeTruthy();
  const received = Stub.mock.calls[0][0] as { programId: string; part: string; keySafe: boolean; audioBus: unknown };
  expect(received).toMatchObject({ programId: 'main', part: 'header', keySafe: true });
  // Without this the packaged clock would never show the song that is on air.
  expect(received.audioBus).toEqual({ getSnapshot: getProgramAudioBusSnapshot, subscribe: subscribeProgramAudioBus });
});

it('renders the local clock when the package does not export it', async () => {
  vi.doMock('@modoitaliano/giorgia/scenes', () => ({}));
  const { GiorgiaClockRenderer } = await import('./GiorgiaClockRenderer');
  const view = render(<GiorgiaClockRenderer programId='main' />);
  expect(await view.findByText(/\d{2}:\d{2}/)).toBeTruthy();
  expect(view.container.querySelector('.modoitaliano-giorgia-clock-header')).not.toBeNull();
});
