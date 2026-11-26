import { describe, expect, it } from 'vitest';
import {
  createProgramSongSequence,
  createProgramSongSequenceItem,
  createProgramTextSequence,
  createProgramTextSequenceItem,
  resolveProgramSongLeaf,
  resolveProgramTextLeaf,
  shuffleProgramSongSequence,
  songIdsInProgramSongSequence,
} from './programSequence';

// gaulatti/alcantara#404 (group C): which item a sequence shows at a given time, for text and song
// sequences, in every mode and loop setting.

const text = (id: string) => ({ id, kind: 'preset', text: id });
const song = (id: string, durationMs?: number) => ({
  id,
  kind: 'preset',
  artist: id.toUpperCase(),
  title: `Song ${id}`,
  coverUrl: `/${id}.jpg`,
  ...(durationMs === undefined ? {} : { durationMs }),
});
const textAt = (sequence: unknown, nowMs: number) => resolveProgramTextLeaf({ contentMode: 'sequence', sequence }, nowMs)?.text ?? null;
const songAt = (sequence: unknown, nowMs: number) => resolveProgramSongLeaf({ contentMode: 'sequence', sequence }, nowMs)?.id ?? null;

describe('text sequence selection', () => {
  it('shows nothing when the active item was cleared, and the first item when it is unknown', () => {
    const items = [text('a'), text('b')];
    expect(textAt({ mode: 'manual', items, activeItemId: null }, 0)).toBeNull();
    expect(textAt({ mode: 'manual', items, activeItemId: 'zzz' }, 0)).toBe('a');
  });

  it('advances one item per interval from the start time, with the 4 s default for an interval under 500 ms', () => {
    const base = { mode: 'autoplay', items: [text('a'), text('b'), text('c')], activeItemId: 'a', startedAt: 1000, intervalMs: 2000 };
    expect(textAt(base, 1000)).toBe('a');
    expect(textAt(base, 3000)).toBe('b');
    expect(textAt(base, 5000)).toBe('c');
    expect(textAt(base, 7000)).toBe('a');
    expect(textAt(base, 500)).toBe('a');
    const tooFast = { ...base, intervalMs: 10 };
    expect(textAt(tooFast, 1500)).toBe('a');
    expect(textAt(tooFast, 5000)).toBe('b');
  });

  it('stops on the last item when the sequence does not loop', () => {
    const base = { mode: 'autoplay', items: [text('a'), text('b')], activeItemId: 'a', startedAt: 0, intervalMs: 1000, loop: false };
    expect(textAt(base, 1000)).toBe('b');
    expect(textAt(base, 90_000)).toBe('b');
  });

  it('starts from now when no start time was saved, and from the active item', () => {
    const items = [text('a'), text('b'), text('c')];
    expect(textAt({ mode: 'autoplay', items, activeItemId: 'b' }, 12_345)).toBe('b');
  });

  it('shows nothing for an empty sequence', () => {
    expect(textAt({ mode: 'autoplay', items: [] }, 0)).toBeNull();
  });
});

describe('song sequence selection', () => {
  it('shows nothing when the active song was cleared, and the first when it is unknown', () => {
    const items = [song('a'), song('b')];
    expect(songAt({ mode: 'manual', items, activeItemId: null }, 0)).toBeNull();
    expect(songAt({ mode: 'manual', items, activeItemId: 'zzz' }, 0)).toBe('a');
    expect(songAt({ mode: 'manual', items, activeItemId: 'b' }, 0)).toBe('b');
  });

  it('follows each song by its length and wraps when every length is known', () => {
    const base = { mode: 'autoplay', items: [song('a', 1000), song('b', 2000)], activeItemId: 'a', startedAt: 0 };
    expect(songAt(base, 500)).toBe('a');
    expect(songAt(base, 1000)).toBe('b');
    expect(songAt(base, 2999)).toBe('b');
    expect(songAt(base, 3000)).toBe('a');
    expect(songAt(base, 3500)).toBe('a');
    // Starting from the second song, the cycle runs b then a.
    expect(songAt({ ...base, activeItemId: 'b' }, 500)).toBe('b');
    expect(songAt({ ...base, activeItemId: 'b' }, 2000)).toBe('a');
  });

  it('stops at the first song of unknown length while looping', () => {
    const base = { mode: 'autoplay', items: [song('a', 1000), song('b'), song('c', 500)], activeItemId: 'a', startedAt: 0 };
    expect(songAt(base, 500)).toBe('a');
    expect(songAt(base, 1000)).toBe('b');
    expect(songAt(base, 60_000)).toBe('b');
    // A sequence that starts on the song of unknown length stays on it.
    expect(songAt({ ...base, activeItemId: 'b' }, 5000)).toBe('b');
  });

  it('plays through once and rests on the last song when it does not loop', () => {
    const base = { mode: 'autoplay', items: [song('a', 1000), song('b', 1000), song('c', 1000)], activeItemId: 'a', startedAt: 0, loop: false };
    expect(songAt(base, 0)).toBe('a');
    expect(songAt(base, 1000)).toBe('b');
    expect(songAt(base, 2500)).toBe('c');
    expect(songAt(base, 90_000)).toBe('c');
  });

  it('rests on a song of unknown length without looping', () => {
    const base = { mode: 'autoplay', items: [song('a', 1000), song('b'), song('c', 1000)], activeItemId: 'a', startedAt: 0, loop: false };
    expect(songAt(base, 500)).toBe('a');
    expect(songAt(base, 5000)).toBe('b');
  });

  it('counts from now when no start time was saved', () => {
    const items = [song('a', 1000), song('b', 1000)];
    expect(songAt({ mode: 'autoplay', items, activeItemId: 'a' }, 77_000)).toBe('a');
  });

  it('shows nothing for an empty sequence and descends into nested sequences', () => {
    expect(songAt({ mode: 'autoplay', items: [] }, 0)).toBeNull();
    const nested = {
      mode: 'manual',
      activeItemId: 'block',
      items: [{ id: 'block', kind: 'sequence', label: 'Block', sequence: { mode: 'manual', activeItemId: 'x', items: [song('x')] } }],
    };
    const leaf = resolveProgramSongLeaf({ contentMode: 'sequence', sequence: nested }, 0);
    expect(leaf?.id).toBe('x');
    expect(leaf?.activePathLabels).toEqual(['Block', 'X - Song x']);
  });
});

describe('shuffle of a sequence', () => {
  it('keeps the saved active id when it names no song in the list', () => {
    const sequence = { mode: 'manual', activeItemId: 'gone', items: [song('a'), song('b'), song('c')] } as never;
    const output = shuffleProgramSongSequence(sequence, 'gone', () => 0);
    expect(output.activeItemId).toBe('gone');
    expect(output.items).toHaveLength(3);
  });

  it('keeps the active item first and a visible change of order when randomness changes nothing', () => {
    const sequence = { mode: 'manual', activeItemId: null, items: [song('a'), song('b')] } as never;
    const output = shuffleProgramSongSequence(sequence, null, () => 0.999);
    expect(output.mode).toBe('shuffle');
    expect(output.shuffleOrder).toEqual(['b', 'a']);
    expect(output.activeItemId).toBe('b');
  });
});

describe('song ids and new items', () => {
  it('lists the catalog ids of the playlist, including nested blocks, and none for no playlist', () => {
    expect(songIdsInProgramSongSequence(null)).toEqual(new Set());
    const playlist = {
      mode: 'manual',
      activeItemId: null,
      items: [
        { ...song('a'), songId: 4 },
        song('b'),
        { id: 'block', kind: 'sequence', label: 'Block', sequence: { mode: 'manual', activeItemId: null, items: [{ ...song('c'), songId: 9 }] } },
      ],
    } as never;
    expect(songIdsInProgramSongSequence(playlist)).toEqual(new Set([4, 9]));
  });

  it('creates a nested block with an empty manual sequence, and a song preset by default', () => {
    const block = createProgramSongSequenceItem('sequence');
    expect(block).toMatchObject({ kind: 'sequence', label: 'Nested Sequence', sequence: { mode: 'manual', items: [] } });
    expect(createProgramSongSequenceItem().kind).toBe('preset');
  });
});

describe('new text items and sequences', () => {
  it('creates an empty preset, with a marquee switch only when the component has one', () => {
    expect(createProgramTextSequenceItem()).toMatchObject({ kind: 'preset', text: '', useMarquee: undefined });
    expect(createProgramTextSequenceItem('preset', { includeMarquee: true })).toMatchObject({ useMarquee: false });
  });

  it('creates a nested block holding a manual sequence with one empty preset', () => {
    const block = createProgramTextSequenceItem('sequence', { includeMarquee: true });
    expect(block).toMatchObject({ kind: 'sequence', label: 'Nested Sequence' });
    const inner = (block as { sequence: { mode: string; items: unknown[]; activeItemId: string } }).sequence;
    expect(inner.mode).toBe('manual');
    expect(inner.items).toHaveLength(1);
    expect(inner.activeItemId).toBe((inner.items[0] as { id: string }).id);
  });

  it('starts a sequence on its first item with a 4 s interval that loops', () => {
    expect(createProgramTextSequence()).toMatchObject({ mode: 'manual', intervalMs: 4000, loop: true });
    expect(createProgramSongSequence().mode).toBe('autoplay');
    expect(createProgramSongSequence('shuffle').mode).toBe('shuffle');
  });
});
