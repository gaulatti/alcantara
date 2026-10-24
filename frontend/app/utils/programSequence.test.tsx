import { describe, expect, it, vi } from 'vitest';
import {
  countProgramSongSequenceLeafItems,
  countProgramTextSequenceLeafItems,
  createProgramSongSequence,
  createProgramTextSequence,
  getProgramSongSequenceSelectedItemId,
  getProgramTextSequenceSelectedItemId,
  normalizeProgramSongSequence,
  normalizeProgramTextSequence,
  resolveProgramSongLeaf,
  resolveProgramTextContent,
  resolveProgramTextLeaf,
  type ProgramSongSequence,
  type ProgramTextSequence,
} from './programSequence';

const textSequence = (overrides: Partial<ProgramTextSequence> = {}): ProgramTextSequence => ({
  mode: 'autoplay', activeItemId: 'a', intervalMs: 1000, loop: true, startedAt: 0,
  items: [
    { id: 'a', kind: 'preset', text: 'Opening' },
    { id: 'b', kind: 'preset', text: 'Headlines', useMarquee: true },
  ],
  ...overrides,
});
const songSequence = (overrides: Partial<ProgramSongSequence> = {}): ProgramSongSequence => ({
  mode: 'autoplay', activeItemId: 'a', loop: true, startedAt: 0,
  items: [
    { id: 'a', kind: 'preset', artist: 'Artist A', title: 'Short', coverUrl: '', durationMs: 1000 },
    { id: 'b', kind: 'preset', artist: 'Artist B', title: 'Long', coverUrl: '', durationMs: 3000 },
  ],
  ...overrides,
});

describe('program sequence playback', () => {
  it('advances text at the boundary, wraps loops, and holds the final non-looping item', () => {
    expect(getProgramTextSequenceSelectedItemId(textSequence(), 999)).toBe('a');
    expect(getProgramTextSequenceSelectedItemId(textSequence(), 1000)).toBe('b');
    expect(getProgramTextSequenceSelectedItemId(textSequence(), 2000)).toBe('a');
    expect(getProgramTextSequenceSelectedItemId(textSequence({ loop: false }), 9000)).toBe('b');
    expect(getProgramTextSequenceSelectedItemId(textSequence({ mode: 'manual', activeItemId: 'b' }), 9000)).toBe('b');
  });

  it('keeps stopped and empty text sequences off air', () => {
    expect(getProgramTextSequenceSelectedItemId(textSequence({ activeItemId: null }), 0)).toBeNull();
    expect(getProgramTextSequenceSelectedItemId(textSequence({ items: [] }), 0)).toBeNull();
    expect(resolveProgramTextLeaf({ contentMode: 'text', sequence: textSequence() })).toBeNull();
  });

  it('uses actual unequal song durations across repeated loops and a selected starting item', () => {
    const sequence = songSequence();
    expect(getProgramSongSequenceSelectedItemId(sequence, 999)).toBe('a');
    expect(getProgramSongSequenceSelectedItemId(sequence, 1000)).toBe('b');
    expect(getProgramSongSequenceSelectedItemId(sequence, 3999)).toBe('b');
    expect(getProgramSongSequenceSelectedItemId(sequence, 4000)).toBe('a');
    expect(getProgramSongSequenceSelectedItemId(sequence, 12001)).toBe('a');
    expect(getProgramSongSequenceSelectedItemId(songSequence({ activeItemId: 'b' }), 2999)).toBe('b');
    expect(getProgramSongSequenceSelectedItemId(songSequence({ activeItemId: 'b' }), 3000)).toBe('a');
    expect(getProgramSongSequenceSelectedItemId(songSequence({ loop: false }), 100000)).toBe('b');
  });

  it('does not invent an end time for unknown-duration songs', () => {
    const sequence = songSequence();
    sequence.items[1] = { id: 'b', kind: 'preset', artist: 'Live', title: 'Unknown', coverUrl: '' };
    expect(getProgramSongSequenceSelectedItemId(sequence, 50000)).toBe('b');
    expect(getProgramSongSequenceSelectedItemId({ ...sequence, loop: false }, 50000)).toBe('b');
    expect(getProgramSongSequenceSelectedItemId({ ...sequence, mode: 'manual' }, 50000)).toBe('a');
    expect(getProgramSongSequenceSelectedItemId({ ...sequence, activeItemId: null }, 0)).toBeNull();
    expect(getProgramSongSequenceSelectedItemId({ ...sequence, items: [] }, 0)).toBeNull();
  });

  it('resolves nested editorial text and song identity without losing its source path', () => {
    const nestedText = textSequence({ mode: 'manual', items: [
      { id: 'a', kind: 'sequence', label: 'Bulletin', sequence: textSequence({ mode: 'manual', activeItemId: 'b' }) },
    ] });
    expect(resolveProgramTextContent({ sequence: nestedText }, 0, { includeMarquee: true })).toEqual({
      text: 'Headlines', useMarquee: true, source: 'sequence', activePathLabels: ['Bulletin', 'Headlines'],
    });
    expect(countProgramTextSequenceLeafItems(nestedText)).toBe(2);
    const nestedSong = songSequence({ mode: 'manual', items: [
      { id: 'a', kind: 'sequence', label: 'Afternoon', sequence: songSequence({ mode: 'manual', activeItemId: 'b' }) },
    ] });
    expect(resolveProgramSongLeaf({ sequence: nestedSong }, 0)).toMatchObject({
      id: 'b', artist: 'Artist B', title: 'Long', durationMs: 3000, activePathLabels: ['Afternoon', 'Artist B - Long'],
    });
    expect(countProgramSongSequenceLeafItems(nestedSong)).toBe(2);
    expect(countProgramSongSequenceLeafItems(null)).toBe(0);
    expect(countProgramTextSequenceLeafItems(null)).toBe(0);
  });

  it('keeps explicit text authoritative over a supplied sequence and handles an empty sequence', () => {
    expect(resolveProgramTextContent({ contentMode: 'text', text: 'Live', useMarquee: true, sequence: textSequence() })).toEqual({
      text: 'Live', useMarquee: true, source: 'text', activePathLabels: [],
    });
    expect(resolveProgramTextContent({ contentMode: 'sequence', sequence: { items: [] }, text: 'Unavailable' }).text).toBe('Unavailable');
    expect(resolveProgramSongLeaf({ sequence: { items: [] } })).toBeNull();
  });

  it('normalizes malformed persisted sequences without admitting malformed items or metadata', () => {
    expect(normalizeProgramSongSequence(null)).toBeNull();
    expect(normalizeProgramTextSequence([])).toBeNull();
    expect(normalizeProgramSongSequence({}, 9)).toBeNull();
    expect(normalizeProgramTextSequence({}, 9)).toBeNull();
    const song = normalizeProgramSongSequence({
      items: [null, 7, { id: 'song', artist: ' Artist ', title: ' Title ', coverUrl: ' cover ', audioUrl: ' audio ',
        songId: 4, highRotation: true, durationMs: 1234.6, earoneSongId: 21, earoneRank: ' 2 ', earoneSpins: 15 }],
      activeItemId: 'missing', intervalMs: 1500.9, startedAt: 100, loop: false,
    });
    expect(song).toMatchObject({ mode: 'autoplay', activeItemId: 'song', intervalMs: 1500, loop: false, startedAt: 100 });
    expect(song?.items).toEqual([{
      id: 'song', kind: 'preset', artist: 'Artist', title: 'Title', coverUrl: 'cover', audioUrl: 'audio',
      songId: 4, highRotation: true, durationMs: 1235, earoneSongId: '21', earoneRank: '2', earoneSpins: '15',
    }]);
    const invalid = normalizeProgramSongSequence({ items: [{ id: 'bad', songId: -1, durationMs: Infinity, highRotation: 'true' }], mode: 'unexpected', activeItemId: null });
    expect(invalid).toMatchObject({ mode: 'manual', activeItemId: null });
    expect(invalid?.items[0]).toMatchObject({ songId: undefined, durationMs: undefined, highRotation: false });
    expect(normalizeProgramTextSequence({ items: [null, { id: 'a', label: 'Old preset' }] })?.items).toEqual([
      { id: 'a', kind: 'preset', text: 'Old preset', useMarquee: undefined },
    ]);
  });

  it('creates editable sequences with distinct identities and deliberately different playback defaults', () => {
    vi.useFakeTimers();
    vi.setSystemTime(12345);
    try {
      const text = createProgramTextSequence('manual', { includeMarquee: true });
      expect(text).toMatchObject({ mode: 'manual', startedAt: 12345, loop: true, intervalMs: 4000 });
      expect(text.activeItemId).toBe(text.items[0].id);
      expect(text.items[0]).toMatchObject({ kind: 'preset', text: '', useMarquee: false });
      const song = createProgramSongSequence();
      expect(song).toMatchObject({ mode: 'autoplay', activeItemId: null, items: [], startedAt: 12345 });
    } finally { vi.useRealTimers(); }
  });
});
