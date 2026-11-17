import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { ToniChyronSequenceEditor } from './ToniChyronSequenceEditor';
import type { ToniChyronSequence } from '../../utils/toniChyronSequence';

// gaulatti/alcantara#197: a saved top-level chyron is shown as its own
// sequence. Wrapping it used to keep only its text, so a marquee chyron showed
// unchecked and lost its marquee, and its chart values, on the first edit.

afterEach(cleanup);

const saved: ToniChyronSequence = {
  mode: 'manual',
  activeItemId: 'chyron',
  items: [
    {
      id: 'chyron',
      kind: 'preset',
      text: 'Ultime notizie',
      useMarquee: true,
      earoneSongId: '881',
      earoneRank: '3',
      earoneSpins: '120',
      externalChartId: 'chart-7',
      externalChartSongId: 'song-9',
      externalChartRank: '4',
      externalChartSpins: '98',
    },
  ],
};

function Harness({ changes }: { changes: ToniChyronSequence[] }) {
  const [sequence, setSequence] = useState(saved);
  return (
    <ToniChyronSequenceEditor
      sequence={sequence}
      onChange={(next) => {
        changes.push(next);
        setSequence(next);
      }}
    />
  );
}

it('keeps a saved marquee chyron checked, and keeps its marquee and chart values after an edit', () => {
  const changes: ToniChyronSequence[] = [];
  render(<Harness changes={changes} />);
  const marquee = screen.getByRole('checkbox', { name: 'Force marquee scrolling' });
  expect(marquee).toBeChecked();

  fireEvent.change(screen.getByDisplayValue('Ultime notizie'), { target: { value: 'Ultimissime' } });
  const edited = changes[changes.length - 1].items[0];
  expect(edited).toMatchObject({ id: 'chyron', kind: 'sequence', label: 'Ultime notizie' });
  const leaf = edited.kind === 'sequence' ? edited.sequence.items[0] : undefined;
  expect(leaf).toMatchObject({
    kind: 'preset',
    text: 'Ultimissime',
    useMarquee: true,
    earoneSongId: '881',
    earoneRank: '3',
    earoneSpins: '120',
    externalChartId: 'chart-7',
    externalChartSongId: 'song-9',
    externalChartRank: '4',
    externalChartSpins: '98',
  });
  // The leaf keeps its own id, distinct from the block that wraps it.
  expect(leaf?.id).not.toBe('chyron');
  expect(screen.getByRole('checkbox', { name: 'Force marquee scrolling' })).toBeChecked();
});

it('keeps a chyron without a marquee unchecked', () => {
  const changes: ToniChyronSequence[] = [];
  function Plain() {
    const [sequence, setSequence] = useState<ToniChyronSequence>({
      mode: 'manual',
      activeItemId: 'a',
      items: [{ id: 'a', kind: 'preset', text: 'Plain' }],
    });
    return <ToniChyronSequenceEditor sequence={sequence} onChange={(next) => (changes.push(next), setSequence(next))} />;
  }
  render(<Plain />);
  expect(screen.getByRole('checkbox', { name: 'Force marquee scrolling' })).not.toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Force marquee scrolling' }));
  const edited = changes[changes.length - 1].items[0];
  expect(edited.kind === 'sequence' ? edited.sequence.items[0] : undefined).toMatchObject({ text: 'Plain', useMarquee: true });
});
