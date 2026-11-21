import { describe, expect, it } from 'vitest';
import {
  countProgramSongSequenceLeafItems,
  countProgramTextSequenceLeafItems,
  getProgramSongContentMode,
  getProgramSongSequenceSelectedItemId,
  getProgramTextContentMode,
  getProgramTextSequenceSelectedItemId,
  normalizeProgramSongSequence,
  normalizeProgramTextSequence,
  resolveProgramSongLeaf,
  resolveProgramTextContent,
  resolveProgramTextLeaf,
  shuffleProgramSongSequence,
  type ProgramSongSequence,
  type ProgramTextSequence
} from './programSequence';

const nest = (depth: number): unknown =>
  depth === 0
    ? { items: [{ id: 'leaf', kind: 'preset', text: 'deep' }] }
    : { items: [{ id: `n${depth}`, kind: 'sequence', label: `L${depth}`, sequence: nest(depth - 1) }] };

describe('text sequence normalization', () => {
  it('rejects non-objects and sequences nested too deeply', () => {
    expect(normalizeProgramTextSequence('x')).toBeNull();
    expect(normalizeProgramTextSequence({}, 9)).toBeNull();
    const shallow = normalizeProgramTextSequence(nest(8));
    expect(countProgramTextSequenceLeafItems(shallow)).toBe(1);
    const tooDeep = normalizeProgramTextSequence(nest(9));
    expect(countProgramTextSequenceLeafItems(tooDeep)).toBe(0);
  });

  it('reads leaves from text or label, names unnamed nested sequences, and drops unreadable items', () => {
    const sequence = normalizeProgramTextSequence(
      {
        mode: 'shuffle',
        items: [
          null,
          { id: 'a', text: '  ', label: 'From label', useMarquee: 1 },
          { id: 'b', text: 3 },
          { kind: 'sequence', label: '  ', sequence: { items: [] } },
          { kind: 'sequence', sequence: 'broken' }
        ],
        activeItemId: 'missing',
        intervalMs: 100,
        loop: 0,
        startedAt: Number.NaN
      },
      0,
      { includeMarquee: true }
    )!;
    expect(sequence.mode).toBe('shuffle');
    expect(sequence.items).toHaveLength(3);
    expect(sequence.items[0]).toEqual({ id: 'a', kind: 'preset', text: 'From label', useMarquee: true });
    expect(sequence.items[1]).toMatchObject({ id: 'b', text: '' });
    expect(sequence.items[2]).toMatchObject({ kind: 'sequence', label: 'Nested Sequence' });
    expect(sequence.items[2].id).toMatch(/^sequence_/);
    expect(sequence.activeItemId).toBe('a');
    expect(sequence.intervalMs).toBe(4000);
    expect(sequence.loop).toBe(false);
    expect(typeof sequence.startedAt).toBe('number');
    expect(normalizeProgramTextSequence({ items: [], activeItemId: null })?.activeItemId).toBeNull();
    expect(normalizeProgramTextSequence({ items: 'none', mode: 'autoplay' })).toMatchObject({ items: [], mode: 'autoplay', activeItemId: null });
  });
});

describe('song sequence normalization', () => {
  it('rejects non-objects and sequences nested too deeply', () => {
    expect(normalizeProgramSongSequence(null)).toBeNull();
    expect(normalizeProgramSongSequence({}, 9)).toBeNull();
  });

  it('keeps valid song fields, converts numeric chart fields and drops invalid ones', () => {
    const sequence = normalizeProgramSongSequence({
      items: [
        7,
        {
          id: 's1',
          songId: 4,
          highRotation: true,
          artist: ' Modugno ',
          title: ' Volare ',
          coverUrl: ' https://media.example.test/c.jpg ',
          audioUrl: ' https://media.example.test/a.mp3 ',
          durationMs: 1500.4,
          earoneSongId: 12,
          earoneRank: ' 3 ',
          earoneSpins: 40
        },
        { songId: 1.5, earoneSongId: ' e-1 ', earoneSpins: ' 9 ', earoneRank: '  ', durationMs: -1 },
        { earoneSongId: Number.NaN, earoneSpins: Number.NaN },
        { kind: 'sequence', id: 'n', label: 'Block', sequence: { items: [] } },
        { kind: 'sequence', sequence: null }
      ]
    })!;
    expect(sequence.mode).toBe('autoplay');
    expect(sequence.items).toHaveLength(4);
    expect(sequence.items[0]).toEqual({
      id: 's1',
      kind: 'preset',
      songId: 4,
      highRotation: true,
      artist: 'Modugno',
      title: 'Volare',
      coverUrl: 'https://media.example.test/c.jpg',
      audioUrl: 'https://media.example.test/a.mp3',
      durationMs: 1500,
      earoneSongId: '12',
      earoneRank: '3',
      earoneSpins: '40'
    });
    expect(sequence.items[1]).toMatchObject({ songId: undefined, earoneSongId: 'e-1', earoneSpins: '9', earoneRank: undefined, durationMs: undefined });
    expect(sequence.items[1].id).toMatch(/^song_/);
    expect(sequence.items[2]).toMatchObject({ earoneSongId: undefined, earoneSpins: undefined, artist: '', audioUrl: undefined });
    expect(sequence.items[3]).toMatchObject({ id: 'n', kind: 'sequence', label: 'Block' });
  });
});

describe('content modes', () => {
  const sequence = normalizeProgramTextSequence({ items: [] });

  it('uses the stated text mode, else a sequence when one exists', () => {
    expect(getProgramTextContentMode('text', sequence)).toBe('text');
    expect(getProgramTextContentMode('sequence', null)).toBe('sequence');
    expect(getProgramTextContentMode(undefined, sequence)).toBe('sequence');
    expect(getProgramTextContentMode(undefined, null)).toBe('text');
    expect(getProgramSongContentMode('anything', null)).toBe('sequence');
  });
});

describe('text sequence selection', () => {
  const items = [
    { id: 'a', kind: 'preset' as const, text: 'A' },
    { id: 'b', kind: 'preset' as const, text: 'B' },
    { id: 'c', kind: 'preset' as const, text: 'C' }
  ];
  const base: ProgramTextSequence = { mode: 'autoplay', items, activeItemId: 'a', intervalMs: 1000, loop: true, startedAt: 0 };

  it('selects nothing for an empty or deliberately unselected sequence', () => {
    expect(getProgramTextSequenceSelectedItemId({ ...base, items: [] }, 0)).toBeNull();
    expect(getProgramTextSequenceSelectedItemId({ ...base, activeItemId: null }, 0)).toBeNull();
  });

  it('holds the active item in manual mode, falling back to the first when the id is unknown', () => {
    expect(getProgramTextSequenceSelectedItemId({ ...base, mode: 'manual', activeItemId: 'b' }, 99999)).toBe('b');
    expect(getProgramTextSequenceSelectedItemId({ ...base, mode: 'manual', activeItemId: 'zz' }, 99999)).toBe('a');
  });

  it('advances by interval, wrapping when looping and stopping on the last item otherwise', () => {
    expect(getProgramTextSequenceSelectedItemId(base, 4500)).toBe('b');
    expect(getProgramTextSequenceSelectedItemId({ ...base, loop: false }, 4500)).toBe('c');
    expect(getProgramTextSequenceSelectedItemId({ ...base, loop: false }, 1500)).toBe('b');
    expect(getProgramTextSequenceSelectedItemId({ ...base, startedAt: undefined, intervalMs: undefined }, 4500)).toBe('a');
  });
});

describe('song sequence selection', () => {
  const song = (id: string, durationMs?: number) => ({ id, kind: 'preset' as const, artist: '', title: '', coverUrl: '', durationMs });
  const base: ProgramSongSequence = {
    mode: 'autoplay',
    items: [song('a', 1000), song('b', 2000), song('c', 1000)],
    activeItemId: 'a',
    loop: true,
    startedAt: 0
  };

  it('selects nothing for an empty or unselected sequence, and holds the item in manual mode', () => {
    expect(getProgramSongSequenceSelectedItemId({ ...base, items: [] }, 0)).toBeNull();
    expect(getProgramSongSequenceSelectedItemId({ ...base, activeItemId: null }, 0)).toBeNull();
    expect(getProgramSongSequenceSelectedItemId({ ...base, mode: 'manual', activeItemId: 'c' }, 5000)).toBe('c');
  });

  it('walks a looping sequence of known durations through its cycle', () => {
    expect(getProgramSongSequenceSelectedItemId(base, 500)).toBe('a');
    expect(getProgramSongSequenceSelectedItemId(base, 2500)).toBe('b');
    expect(getProgramSongSequenceSelectedItemId(base, 3500)).toBe('c');
    expect(getProgramSongSequenceSelectedItemId(base, 4500)).toBe('a');
    expect(getProgramSongSequenceSelectedItemId({ ...base, startedAt: undefined }, 4500)).toBe('a');
  });

  it('stops at the first song of unknown length in a looping sequence', () => {
    const unknown = { ...base, items: [song('a', 1000), song('b'), song('c', 1000)] };
    expect(getProgramSongSequenceSelectedItemId(unknown, 500)).toBe('a');
    expect(getProgramSongSequenceSelectedItemId(unknown, 5000)).toBe('b');
    const nested = { ...base, items: [song('a', 1000), { id: 'n', kind: 'sequence' as const, label: 'N', sequence: base }] };
    expect(getProgramSongSequenceSelectedItemId(nested, 5000)).toBe('n');
  });

  it('plays a non-looping sequence once and stays on the last song', () => {
    const once = { ...base, loop: false };
    expect(getProgramSongSequenceSelectedItemId(once, 1500)).toBe('b');
    expect(getProgramSongSequenceSelectedItemId(once, 99999)).toBe('c');
    expect(getProgramSongSequenceSelectedItemId({ ...once, items: [song('a'), song('b', 1)] }, 99999)).toBe('a');
  });
});

describe('resolving text content', () => {
  const sequence = {
    mode: 'manual',
    items: [
      { id: 'n', kind: 'sequence', label: 'Block', sequence: { mode: 'manual', items: [{ id: 'x', text: 'Hello', useMarquee: true }] } }
    ]
  };

  it('resolves the active leaf of a nested sequence with its path', () => {
    expect(resolveProgramTextContent({ sequence }, 0, { includeMarquee: true })).toEqual({
      text: 'Hello',
      useMarquee: true,
      source: 'sequence',
      activePathLabels: ['Block', 'Hello']
    });
    expect(resolveProgramTextLeaf({ sequence }, 0)).toEqual({ text: 'Hello', useMarquee: false, activePathLabels: ['Block', 'Hello'] });
  });

  it('falls back to the plain text when there is no sequence or it selects nothing', () => {
    expect(resolveProgramTextContent({ text: 'Plain', useMarquee: true })).toEqual({
      text: 'Plain',
      useMarquee: true,
      source: 'text',
      activePathLabels: []
    });
    expect(resolveProgramTextContent({ contentMode: 'sequence', sequence: { items: [] } })).toMatchObject({ text: '', source: 'text' });
    expect(resolveProgramTextContent({ contentMode: 'text', sequence })).toMatchObject({ source: 'text' });
    expect(resolveProgramTextLeaf({ contentMode: 'text', sequence })).toBeNull();
    expect(resolveProgramTextLeaf({})).toBeNull();
    expect(resolveProgramTextLeaf({ sequence: { items: [] } })).toBeNull();
  });
});

describe('resolving songs', () => {
  it('resolves the active song with its path, naming an untitled preset', () => {
    const sequence = {
      mode: 'manual',
      items: [{ id: 'n', kind: 'sequence', label: 'Hits', sequence: { mode: 'manual', items: [{ id: 's', artist: 'Modugno', title: 'Volare', highRotation: true }] } }]
    };
    expect(resolveProgramSongLeaf({ sequence })).toMatchObject({
      id: 's',
      highRotation: true,
      activePathLabels: ['Hits', 'Modugno - Volare']
    });
    expect(resolveProgramSongLeaf({ sequence: { mode: 'manual', items: [{ id: 'u' }] } })?.activePathLabels).toEqual(['Song Preset']);
  });

  it('resolves nothing without a sequence or a selection', () => {
    expect(resolveProgramSongLeaf({})).toBeNull();
    expect(resolveProgramSongLeaf({ sequence: { items: [] } })).toBeNull();
  });
});

describe('leaf counts', () => {
  it('counts leaves through nested sequences, and none for a missing sequence', () => {
    expect(countProgramTextSequenceLeafItems(null)).toBe(0);
    expect(countProgramSongSequenceLeafItems(null)).toBe(0);
    const songs = normalizeProgramSongSequence({
      items: [{ id: 'a' }, { kind: 'sequence', sequence: { items: [{ id: 'b' }, { id: 'c' }] } }]
    });
    expect(countProgramSongSequenceLeafItems(songs)).toBe(3);
  });
});

describe('song shuffle', () => {
  const song = (id: string) => ({ id, kind: 'preset' as const, artist: '', title: '', coverUrl: '' });
  const base: ProgramSongSequence = { mode: 'autoplay', items: [song('a'), song('b'), song('c')], activeItemId: null };

  it('leaves a sequence of fewer than two songs alone', () => {
    const single = { ...base, items: [song('a')] };
    expect(shuffleProgramSongSequence(single)).toBe(single);
  });

  it('keeps the active song first, and rotates when the shuffle changed nothing', () => {
    const anchored = shuffleProgramSongSequence({ ...base, activeItemId: 'b' }, 'b', () => 0.99);
    expect(anchored.items[0].id).toBe('b');
    expect(anchored.activeItemId).toBe('b');
    const unanchored = shuffleProgramSongSequence(base, null, () => 0.99);
    expect(unanchored.items.map((item) => item.id)).not.toEqual(['a', 'b', 'c']);
    expect(unanchored.mode).toBe('shuffle');
    expect(shuffleProgramSongSequence({ ...base, activeItemId: 'gone' }, 'gone', () => 0).activeItemId).toBe('gone');
  });
});

describe('sequence edge cases', () => {
  it('generates ids for text presets without one and reads a song sequence without items', () => {
    const text = normalizeProgramTextSequence({ items: [{ text: 'No id' }] })!;
    expect(text.items[0].id).toMatch(/^preset_/);
    expect(normalizeProgramSongSequence({ items: 'none' })?.items).toEqual([]);
  });

  it('stops on an unknown-length song even when it is the active one', () => {
    const song = (id: string, durationMs?: number) => ({ id, kind: 'preset' as const, artist: '', title: '', coverUrl: '', durationMs });
    expect(
      getProgramSongSequenceSelectedItemId(
        { mode: 'autoplay', items: [song('a'), song('b', 1000)], activeItemId: 'a', loop: true, startedAt: 0 },
        5000
      )
    ).toBe('a');
  });

  it('keeps the stored active id when the shuffle is not anchored', () => {
    const song = (id: string) => ({ id, kind: 'preset' as const, artist: '', title: '', coverUrl: '' });
    const sequence: ProgramSongSequence = { mode: 'autoplay', items: [song('a'), song('b')], activeItemId: 'b' };
    expect(shuffleProgramSongSequence(sequence, null, () => 0).activeItemId).toBe('b');
  });
});
