import React from 'react';
import { cleanup, render, waitFor, configure } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import BrokawFifthBellProgramRenderer from './BrokawFifthBellProgramRenderer';
import {
  ModoItalianoBracket,
  ModoItalianoGiorgiaChyron,
  ModoItalianoGiorgiaClock,
  ModoItalianoGiorgiaPodcastPlayer,
  ModoItalianoPodcastPlayer,
} from '../scenes/packagedScenes';

// These tests import the packaged scenes after resetting the module registry, which is slow on a loaded
// CI runner: wait for the lazy load for as long as it takes rather than a fixed second.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 15_000 });

// gaulatti/alcantara#391: the packaged components run on this app's single React. Nothing here is
// mocked, so a second copy (an "Invalid hook call", or `useState` of null) fails these renders.
// The app carries no resolve.dedupe: Giorgia and Brokaw declare react as a peer dependency.

const sequence = { mode: 'manual', items: [{ id: 'a', kind: 'preset', text: 'Ciao mondo', useMarquee: false }], activeItemId: 'a' };
const podcast = { show: true } as Record<string, unknown>;
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  errors.mockRestore();
});

const hookErrors = () =>
  errors.mock.calls.map((call: unknown[]) => String(call[0])).filter((message: string) => /Invalid hook call|Cannot read properties of null/.test(message));

it('renders every packaged Giorgia scene without a second React', async () => {
  const view = render(
    <>
      <ModoItalianoGiorgiaChyron show textSequence={sequence as never} />
      <ModoItalianoGiorgiaClock programId='main' />
      <ModoItalianoGiorgiaPodcastPlayer {...(podcast as React.ComponentProps<typeof ModoItalianoGiorgiaPodcastPlayer>)} />
      <ModoItalianoBracket title='TORNEO' />
      <ModoItalianoPodcastPlayer {...(podcast as React.ComponentProps<typeof ModoItalianoPodcastPlayer>)} />
    </>,
  );
  await waitFor(() => expect(view.container.textContent ?? '').toMatch(/CIAO MONDO/i));
  await waitFor(() => expect(view.container.textContent ?? '').toMatch(/\d{2}:\d{2}/));
  await waitFor(() => expect(view.container.textContent ?? '').toMatch(/Gran Final/));
  expect(hookErrors()).toEqual([]);
});

it('renders Brokaw’s LiveProgram without a second React', async () => {
  const view = render(<BrokawFifthBellProgramRenderer programId='main' embedded />);
  await waitFor(() => expect(view.container.firstChild).not.toBeNull());
  expect(hookErrors()).toEqual([]);
});
