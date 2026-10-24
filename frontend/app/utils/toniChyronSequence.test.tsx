import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  countSequenceLeafItems, createToniChyronSequence, createToniChyronSequenceItem,
  getToniChyronContentMode, getToniChyronSequenceSelectedItemId,
  normalizeToniChyronSequence, resolveToniChyronContent, resolveToniChyronLeaf,
  type ToniChyronSequence,
} from './toniChyronSequence';

afterEach(() => vi.useRealTimers());

describe('chyron sequence normalization', () => {
  it('rejects non-record and over-depth input without creating content', () => {
    for (const input of [undefined, null, [], 1, 'text']) expect(normalizeToniChyronSequence(input)).toBeNull();
    expect(normalizeToniChyronSequence({}, 9)).toBeNull();
    expect(normalizeToniChyronSequence({ items: 'bad' })).toMatchObject({ items: [], activeItemId: null });
    expect(normalizeToniChyronSequence({ items: [null, [], 'bad'] })).toMatchObject({ items: [] });
  });
  it('retains valid editorial text and normalizes legacy fields and timing', () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const sequence = normalizeToniChyronSequence({
      mode: 'autoplay', activeItemId: 'two', intervalMs: 750.9, loop: false, startedAt: 5000,
      items: [
        { id: 'one', text: '  Deliberate spacing  ', useMarquee: true, earoneSongId: ' 42 ', earoneRank: ' 1 ', earoneSpins: ' 200 ' },
        { id: 'two', label: 'Legacy editorial label', earoneSongId: 123, earoneSpins: 45 },
        { text: ' ', earoneSongId: Infinity, earoneSpins: Infinity, earoneRank: 1 },
      ],
    })!;
    expect(sequence).toMatchObject({ mode: 'autoplay', activeItemId: 'two', intervalMs: 750, loop: false, startedAt: 5000 });
    expect(sequence.items[0]).toEqual({
      id: 'one', kind: 'preset', text: '  Deliberate spacing  ', useMarquee: true,
      earoneSongId: '42', earoneRank: '1', earoneSpins: '200',
    });
    expect(sequence.items[1]).toMatchObject({ text: 'Legacy editorial label', earoneSongId: '123', earoneSpins: '45', useMarquee: false });
    expect(sequence.items[2]).toMatchObject({ kind: 'preset', text: '', earoneSongId: undefined, earoneRank: undefined, earoneSpins: undefined });
    expect(sequence.items[2].id).toMatch(/^preset_/);
  });
  it('supplies existing sequence defaults and selects the first surviving item', () => {
    vi.useFakeTimers(); vi.setSystemTime(1234);
    const sequence = normalizeToniChyronSequence({ mode: 'bad', activeItemId: 'gone', intervalMs: 499, startedAt: Infinity, items: [{ id: 'one', text: 'Hello' }] });
    expect(sequence).toMatchObject({ mode: 'manual', activeItemId: 'one', intervalMs: 4000, loop: true, startedAt: 1234 });
    expect(normalizeToniChyronSequence({ intervalMs: Infinity, items: [] })?.intervalMs).toBe(4000);
  });
  it('preserves named nesting and rejects missing or excessively deep child sequences', () => {
    const sequence = normalizeToniChyronSequence({ items: [
      { id: 'segment', kind: 'sequence', label: ' Headlines ', sequence: { items: [{ id: 'story', text: 'First story' }] } },
      { kind: 'sequence', label: ' ', sequence: { items: [] } },
      { kind: 'sequence', sequence: null },
    ] })!;
    expect(sequence.items).toHaveLength(2);
    expect(sequence.items[0]).toMatchObject({ id: 'segment', label: ' Headlines ', kind: 'sequence' });
    expect(sequence.items[1]).toMatchObject({ label: 'Nested Sequence', kind: 'sequence' });
    expect(sequence.items[1].id).toMatch(/^sequence_/);
    let nested: unknown = { items: [{ text: 'deep' }] };
    for (let depth = 0; depth < 10; depth += 1) nested = { items: [{ kind: 'sequence', sequence: nested }] };
    const bounded = normalizeToniChyronSequence(nested)!;
    expect(countSequenceLeafItems(bounded)).toBe(0);
  });
});

describe('chyron item selection and rendering', () => {
  const sequence: ToniChyronSequence = {
    mode: 'autoplay', intervalMs: 1000, startedAt: 10000, activeItemId: 'b', loop: true,
    items: [
      { id: 'a', kind: 'preset', text: 'First', useMarquee: false },
      { id: 'b', kind: 'preset', text: 'Second', useMarquee: true, earoneSongId: '42', earoneRank: '1', earoneSpins: '200' },
      { id: 'c', kind: 'preset', text: 'Third' },
    ],
  };
  it('advances from the selected base, wraps loops, and clamps time before start', () => {
    expect(getToniChyronSequenceSelectedItemId(sequence, 9000)).toBe('b');
    expect(getToniChyronSequenceSelectedItemId(sequence, 10000)).toBe('b');
    expect(getToniChyronSequenceSelectedItemId(sequence, 11000)).toBe('c');
    expect(getToniChyronSequenceSelectedItemId(sequence, 12000)).toBe('a');
    expect(getToniChyronSequenceSelectedItemId({ ...sequence, loop: false }, 999999)).toBe('c');
  });
  it('holds manual selections and recovers a removed selected item', () => {
    expect(getToniChyronSequenceSelectedItemId({ ...sequence, mode: 'manual' }, 999999)).toBe('b');
    expect(getToniChyronSequenceSelectedItemId({ ...sequence, mode: 'manual', activeItemId: 'missing' }, 999999)).toBe('a');
    expect(getToniChyronSequenceSelectedItemId({ mode: 'autoplay', items: [] }, 10000)).toBeNull();
    expect(getToniChyronSequenceSelectedItemId({ mode: 'autoplay', items: sequence.items }, 10000)).toBe('a');
  });
  it('resolves nested editorial content and preserves its chart identity and path', () => {
    const nested = { mode: 'manual', items: [{ id: 'segment', kind: 'sequence', label: 'Chart', sequence: { ...sequence, mode: 'manual' } }] };
    expect(resolveToniChyronContent({ sequence: nested }, 10000)).toEqual({
      text: 'Second', useMarquee: true, source: 'sequence', activePathLabels: ['Chart', 'Second'],
    });
    expect(resolveToniChyronLeaf({ contentMode: 'sequence', sequence: nested }, 10000)).toEqual({
      text: 'Second', useMarquee: true, earoneSongId: '42', earoneRank: '1', earoneSpins: '200', activePathLabels: ['Chart', 'Second'],
    });
    expect(countSequenceLeafItems(normalizeToniChyronSequence(nested))).toBe(3);
    expect(countSequenceLeafItems(null)).toBe(0);
  });
  it('uses static text only when explicitly selected or no sequence leaf exists', () => {
    expect(getToniChyronContentMode('text', sequence)).toBe('text');
    expect(getToniChyronContentMode('sequence', null)).toBe('sequence');
    expect(getToniChyronContentMode(undefined, sequence)).toBe('sequence');
    expect(getToniChyronContentMode(undefined, null)).toBe('text');
    expect(resolveToniChyronContent({ text: 'Static', useMarquee: true, contentMode: 'text', sequence }, 10000))
      .toEqual({ text: 'Static', useMarquee: true, source: 'text', activePathLabels: [] });
    expect(resolveToniChyronLeaf({ contentMode: 'text', sequence }, 10000)).toBeNull();
    expect(resolveToniChyronContent({ text: 'Backup', sequence: { items: [] } }, 10000))
      .toEqual({ text: 'Backup', useMarquee: false, source: 'text', activePathLabels: [] });
    expect(resolveToniChyronContent({}, 10000)).toEqual({ text: '', useMarquee: false, source: 'text', activePathLabels: [] });
    expect(resolveToniChyronLeaf({ contentMode: 'sequence', sequence: null }, 10000)).toBeNull();
  });
  it('creates editable preset and nested defaults with a selected first item', () => {
    const preset = createToniChyronSequenceItem();
    expect(preset).toMatchObject({ kind: 'preset', text: '', useMarquee: false });
    expect(preset.id).toMatch(/^preset_/);
    const nested = createToniChyronSequenceItem('sequence');
    expect(nested).toMatchObject({ kind: 'sequence', label: 'Nested Sequence' });
    expect(nested.id).toMatch(/^sequence_/);
    const created = createToniChyronSequence();
    expect(created).toMatchObject({ mode: 'manual', intervalMs: 4000, loop: true });
    expect(created.activeItemId).toBe(created.items[0].id);
    expect(createToniChyronSequence('autoplay').mode).toBe('autoplay');
  });
});
