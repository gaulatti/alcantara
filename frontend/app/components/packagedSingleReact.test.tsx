import React from 'react';
import { cleanup, render, waitFor, configure } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import BrokawFifthBellProgramRenderer from './BrokawFifthBellProgramRenderer';
import { GiorgiaChyronRenderer } from './GiorgiaChyronRenderer';
import { GiorgiaLegacyChyronRenderer } from './GiorgiaLegacyChyronRenderer';
import { GiorgiaLegacyClockRenderer } from './GiorgiaLegacyClockRenderer';

// These tests import the packaged scenes after resetting the module registry, which is slow on a loaded
// CI runner: wait for the lazy load for as long as it takes rather than a fixed second.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 15_000 });

// gaulatti/alcantara#391: the packaged components run on this app's single React. Nothing here is
// mocked, so a second copy (an "Invalid hook call", or `useState` of null) fails these renders.
// The app carries no resolve.dedupe: Giorgia and Brokaw declare react as a peer dependency.

const sequence = { mode: 'manual', items: [{ id: 'a', kind: 'preset', text: 'Ciao mondo', useMarquee: false }], activeItemId: 'a' };
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
  errors.mock.calls.map((call) => String(call[0])).filter((message) => /Invalid hook call|Cannot read properties of null/.test(message));

it('renders the packaged Giorgia chyron and the legacy chyron and clock without a second React', async () => {
  const view = render(
    <>
      <GiorgiaChyronRenderer show textSequence={sequence as never} />
      <GiorgiaLegacyChyronRenderer show textSequence={sequence as never} />
      <GiorgiaLegacyClockRenderer programId='main' />
    </>,
  );
  await waitFor(() => expect(view.container.textContent ?? '').toMatch(/CIAO MONDO/i));
  await waitFor(() => expect(view.container.textContent ?? '').toMatch(/\d{2}:\d{2}/));
  expect(hookErrors()).toEqual([]);
});

it('renders Brokaw’s LiveProgram without a second React', async () => {
  const view = render(<BrokawFifthBellProgramRenderer programId='main' embedded />);
  await waitFor(() => expect(view.container.firstChild).not.toBeNull());
  expect(hookErrors()).toEqual([]);
});
