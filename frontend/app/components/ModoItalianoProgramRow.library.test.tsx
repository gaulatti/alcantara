import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ModoItalianoProgramRow } from './ModoItalianoProgramRow';

// With a Giorgia that ships the program row, the library draws it and gets the same decisions the local row makes.
const seen = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('@modoitaliano/giorgia/scenes', () => ({
  GIORGIA: { safeX: 0, safeBottom: 0 },
  ModoItalianoGiorgiaProgramRow: (props: Record<string, unknown>) => {
    seen.push(props);
    return <p>library program row</p>;
  },
}));

afterEach(cleanup);

it('hands the library row the settings of both components, with one key-safe switch', async () => {
  render(
    <ModoItalianoProgramRow
      plan={{ clockType: 'modoitaliano-giorgia-clock', chyronType: 'modoitaliano-giorgia-chyron', ownedTypes: new Set() } as never}
      metadata={{
        'modoitaliano-giorgia-clock': { showLogo: 'false' },
        'modoitaliano-giorgia-chyron': { show: 0, keySafe: true, textSequence: 'fictional' },
      }}
      programId='fictional-show'
    />,
  );
  expect(await screen.findByText('library program row')).toBeInTheDocument();
  expect(document.querySelector('[data-program-row]')).toBeNull();
  expect(seen.at(-1)).toMatchObject({
    programId: 'fictional-show',
    timeOverride: null,
    clockProps: { showWorldClocks: true, showLogo: false, showPlaybackProgress: true, keySafe: true },
    chyronProps: { show: false, textSequence: 'fictional', keySafe: true },
  });
  expect(seen.at(-1)).toHaveProperty('audioBus.getSnapshot');
});
