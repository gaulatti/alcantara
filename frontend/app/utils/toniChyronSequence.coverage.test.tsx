import { describe, expect, it } from 'vitest';
import {
  countSequenceLeafItems,
  getToniChyronContentMode,
  getToniChyronSequenceSelectedItemId,
  normalizeToniChyronSequence,
  resolveToniChyronContent,
  resolveToniChyronLeaf,
  type ToniChyronSequence
} from './toniChyronSequence';

const nest = (depth: number): unknown =>
  depth === 0
    ? { items: [{ id: 'leaf', text: 'deep' }] }
    : { items: [{ id: `n${depth}`, kind: 'sequence', label: `L${depth}`, sequence: nest(depth - 1) }] };

describe('chyron sequence normalization', () => {
  it('rejects non-objects and drops sequences nested too deeply', () => {
    expect(normalizeToniChyronSequence([])).toBeNull();
    expect(normalizeToniChyronSequence({}, 9)).toBeNull();
    expect(countSequenceLeafItems(normalizeToniChyronSequence(nest(8)))).toBe(1);
    expect(countSequenceLeafItems(normalizeToniChyronSequence(nest(9)))).toBe(0);
    expect(countSequenceLeafItems(null)).toBe(0);
  });

  it('reads leaves from text or label and keeps chart fields, dropping malformed ones', () => {
    const sequence = normalizeToniChyronSequence({
      mode: 'autoplay',
      items: [
        'x',
        { id: 'a', text: 'Hit', earoneSongId: ' e-1 ', earoneRank: ' 2 ', earoneSpins: ' 30 ' },
        { text: '  ', label: 'Fallback', earoneSongId: 5, earoneSpins: 6 },
        { text: 7, earoneSongId: Number.NaN, earoneRank: '  ', earoneSpins: Number.POSITIVE_INFINITY },
        { kind: 'sequence', label: '  ', sequence: { items: [] } },
        { kind: 'sequence', id: 'n', label: 'Block', sequence: { items: [{ id: 'b', text: 'B' }] } },
        { kind: 'sequence', sequence: 'broken' }
      ],
      activeItemId: 'n',
      intervalMs: 1500.7,
      startedAt: 10
    })!;
    expect(sequence).toMatchObject({ mode: 'autoplay', activeItemId: 'n', intervalMs: 1500, loop: true, startedAt: 10 });
    expect(sequence.items).toHaveLength(5);
    expect(sequence.items[0]).toMatchObject({ id: 'a', text: 'Hit', earoneSongId: 'e-1', earoneRank: '2', earoneSpins: '30' });
    expect(sequence.items[1]).toMatchObject({ text: 'Fallback', earoneSongId: '5', earoneSpins: '6' });
    expect(sequence.items[1].id).toMatch(/^preset_/);
    expect(sequence.items[2]).toMatchObject({ text: '', earoneSongId: undefined, earoneRank: undefined, earoneSpins: undefined });
    expect(sequence.items[3]).toMatchObject({ kind: 'sequence', label: 'Nested Sequence' });
    expect(sequence.items[3].id).toMatch(/^sequence_/);
    expect(countSequenceLeafItems(sequence)).toBe(4);
    expect(normalizeToniChyronSequence({ items: 'none', loop: 0 })).toMatchObject({ items: [], activeItemId: null, loop: false, mode: 'manual' });
  });
});

describe('chyron content mode', () => {
  it('uses the stated mode, else a sequence when one exists', () => {
    const sequence = normalizeToniChyronSequence({ items: [] });
    expect(getToniChyronContentMode('text', sequence)).toBe('text');
    expect(getToniChyronContentMode('sequence', null)).toBe('sequence');
    expect(getToniChyronContentMode(undefined, sequence)).toBe('sequence');
    expect(getToniChyronContentMode(undefined, null)).toBe('text');
  });
});

describe('chyron selection', () => {
  const items = ['a', 'b', 'c'].map((id) => ({ id, kind: 'preset' as const, text: id.toUpperCase() }));
  const base: ToniChyronSequence = { mode: 'autoplay', items, activeItemId: 'a', intervalMs: 1000, loop: true, startedAt: 0 };

  it('selects nothing for an empty sequence and holds the item in manual mode', () => {
    expect(getToniChyronSequenceSelectedItemId({ ...base, items: [] }, 0)).toBeNull();
    expect(getToniChyronSequenceSelectedItemId({ ...base, mode: 'manual', activeItemId: 'c' }, 99999)).toBe('c');
    expect(getToniChyronSequenceSelectedItemId({ ...base, mode: 'manual', activeItemId: 'zz' }, 99999)).toBe('a');
  });

  it('advances by interval, wrapping when looping and stopping on the last item otherwise', () => {
    expect(getToniChyronSequenceSelectedItemId(base, 4500)).toBe('b');
    expect(getToniChyronSequenceSelectedItemId({ ...base, loop: false }, 4500)).toBe('c');
    expect(getToniChyronSequenceSelectedItemId({ ...base, loop: false }, 1500)).toBe('b');
    expect(getToniChyronSequenceSelectedItemId({ ...base, startedAt: undefined, intervalMs: undefined }, 4500)).toBe('a');
  });
});

describe('chyron resolution', () => {
  const sequence = {
    items: [{ id: 'n', kind: 'sequence', label: 'Chart', sequence: { items: [{ id: 'x', text: 'Number one', useMarquee: true, earoneRank: '1' }] } }]
  };

  it('resolves the active leaf of a nested sequence with its path and chart fields', () => {
    expect(resolveToniChyronContent({ sequence }, 0)).toEqual({
      text: 'Number one',
      useMarquee: true,
      source: 'sequence',
      activePathLabels: ['Chart', 'Number one']
    });
    expect(resolveToniChyronLeaf({ sequence }, 0)).toMatchObject({ text: 'Number one', earoneRank: '1', activePathLabels: ['Chart', 'Number one'] });
  });

  it('falls back to the plain text, and resolves no leaf, without a usable sequence', () => {
    expect(resolveToniChyronContent({ text: 'Plain', useMarquee: true })).toEqual({ text: 'Plain', useMarquee: true, source: 'text', activePathLabels: [] });
    expect(resolveToniChyronContent({ sequence: { items: [] } })).toEqual({ text: '', useMarquee: false, source: 'text', activePathLabels: [] });
    expect(resolveToniChyronContent({ contentMode: 'text', sequence })).toMatchObject({ source: 'text' });
    expect(resolveToniChyronLeaf({})).toBeNull();
    expect(resolveToniChyronLeaf({ contentMode: 'text', sequence })).toBeNull();
    expect(resolveToniChyronLeaf({ sequence: { items: [] } })).toBeNull();
  });
});
