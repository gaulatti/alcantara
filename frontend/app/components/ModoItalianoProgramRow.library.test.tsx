import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ModoItalianoProgramRow } from './ModoItalianoProgramRow';

// What the library row is handed: the stored settings of both components, unread, and the app's audio bus.
const seen = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('@modoitaliano/giorgia/scenes', () => ({
  ModoItalianoGiorgiaProgramRow: (props: Record<string, unknown>) => {
    seen.push(props);
    return <p>library program row</p>;
  },
}));

afterEach(cleanup);

const plan = { clockType: 'modoitaliano-giorgia-clock', chyronType: 'modoitaliano-giorgia-chyron', ownedTypes: new Set() } as never;

it('hands the library row the stored settings of both components', async () => {
  const clock = { showLogo: 'false' };
  const chyron = { show: 0, keySafe: true, textSequence: 'fictional' };
  render(
    <ModoItalianoProgramRow plan={plan} metadata={{ 'modoitaliano-giorgia-clock': clock, 'modoitaliano-giorgia-chyron': chyron }} programId='fictional-show' />,
  );
  expect(await screen.findByText('library program row')).toBeInTheDocument();
  expect(seen.at(-1)).toMatchObject({ programId: 'fictional-show', timeOverride: null, clockProps: clock, chyronProps: chyron });
  expect(seen.at(-1)).toHaveProperty('audioBus.getSnapshot');
});

it('hands an empty object for a component with no settings', async () => {
  render(<ModoItalianoProgramRow plan={plan} metadata={{}} programId='fictional-show' />);
  expect(await screen.findByText('library program row')).toBeInTheDocument();
  expect(seen.at(-1)).toMatchObject({ clockProps: {}, chyronProps: {} });
});
