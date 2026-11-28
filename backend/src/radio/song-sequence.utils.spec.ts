import {
  countProgramSongLeavesBySong,
  findUniqueProgramSongLeafById,
  findUniqueProgramSongLeafByAudioUrl,
  normalizeProgramSongSequence,
  resolveProgramSongLeaf,
  activeProgramSongLeafId,
  removeProgramSongLeavesInPlace,
} from './song-sequence.utils';
import type { ProgramSongSequence } from './song-sequence.utils';

type Tree = ProgramSongSequence & {
  items: Array<{ id: string; sequence: Tree }>;
};

describe('program song sequence catalog identity', () => {
  it('preserves a stable songId through normalization and resolution', () => {
    const sequence = normalizeProgramSongSequence({
      mode: 'manual',
      items: [
        {
          id: 'item-1',
          kind: 'preset',
          songId: 42,
          artist: 'Artist',
          title: 'Song',
          coverUrl: '',
          audioUrl: 'https://media.test/song.mp3',
        },
      ],
      activeItemId: 'item-1',
      loop: false,
    });

    expect(sequence?.items[0]).toMatchObject({ songId: 42 });
    expect(sequence && resolveProgramSongLeaf(sequence)).toMatchObject({
      id: 'item-1',
      songId: 42,
    });
  });

  it('preserves the high rotation capability through normalization and resolution', () => {
    const sequence = normalizeProgramSongSequence({
      mode: 'shuffle',
      items: [
        {
          id: 'favorite',
          kind: 'preset',
          songId: 9,
          highRotation: true,
          artist: 'Artist',
          title: 'Favorite',
          coverUrl: '',
          audioUrl: 'https://media.test/favorite.mp3',
        },
      ],
      activeItemId: 'favorite',
    });

    expect(sequence?.items[0]).toMatchObject({ highRotation: true });
    expect(sequence && resolveProgramSongLeaf(sequence)).toMatchObject({
      highRotation: true,
    });
  });

  it('keeps legacy metadata-only items playable without inventing a songId', () => {
    const sequence = normalizeProgramSongSequence({
      mode: 'manual',
      items: [
        {
          id: 'legacy',
          kind: 'preset',
          artist: 'Legacy artist',
          title: 'Legacy song',
          coverUrl: '',
          audioUrl: 'https://media.test/legacy.mp3',
        },
      ],
      activeItemId: 'legacy',
    });

    const resolved = sequence && resolveProgramSongLeaf(sequence);
    expect(resolved).toMatchObject({ id: 'legacy', title: 'Legacy song' });
    expect(resolved?.songId).toBeUndefined();
  });

  it('finds a uniquely matching song URL in a nested sequence', () => {
    const sequence = normalizeProgramSongSequence({
      mode: 'autoplay',
      items: [
        {
          id: 'nested',
          kind: 'sequence',
          label: 'Hour one',
          sequence: {
            mode: 'autoplay',
            items: [
              {
                id: 'live-song',
                kind: 'preset',
                artist: 'Live artist',
                title: 'Live song',
                coverUrl: '',
                audioUrl: 'https://media.test/live.mp3',
              },
            ],
          },
        },
      ],
    });

    expect(
      findUniqueProgramSongLeafByAudioUrl(
        sequence,
        'https://media.test/live.mp3',
      ),
    ).toMatchObject({
      id: 'live-song',
      activePathLabels: ['Hour one', 'Live artist - Live song'],
    });
  });

  it('finds a uniquely identified playlist leaf for Play Next', () => {
    const sequence = normalizeProgramSongSequence({
      mode: 'autoplay',
      items: [
        {
          id: 'queued-song',
          kind: 'preset',
          artist: 'Queue artist',
          title: 'Queue song',
          coverUrl: '',
          audioUrl: 'https://media.test/queue.mp3',
        },
      ],
    });

    expect(
      findUniqueProgramSongLeafById(sequence, 'queued-song'),
    ).toMatchObject({
      id: 'queued-song',
      title: 'Queue song',
    });
    expect(findUniqueProgramSongLeafById(sequence, 'missing')).toBeNull();
  });

  it('refuses to guess when the same audio URL appears more than once', () => {
    const sequence = normalizeProgramSongSequence({
      mode: 'autoplay',
      items: ['one', 'two'].map((id) => ({
        id,
        kind: 'preset',
        artist: 'Artist',
        title: id,
        coverUrl: '',
        audioUrl: 'https://media.test/duplicate.mp3',
      })),
    });

    expect(
      findUniqueProgramSongLeafByAudioUrl(
        sequence,
        'https://media.test/duplicate.mp3',
      ),
    ).toBeNull();
  });
});

describe('countProgramSongLeavesBySong (#280)', () => {
  const leaf = (id: string, fields: Record<string, unknown>) => ({
    id,
    kind: 'preset',
    artist: '',
    title: '',
    coverUrl: '',
    ...fields,
  });

  it('counts leaves per song id, else per audio address, across nested sequences, with a label', () => {
    const sequence = normalizeProgramSongSequence({
      mode: 'manual',
      items: [
        leaf('a', {
          songId: 7,
          artist: 'Artist',
          title: 'Song',
          audioUrl: 'https://m.test/1.mp3',
        }),
        leaf('b', { songId: 7, audioUrl: 'https://m.test/2.mp3' }),
        {
          id: 'n',
          kind: 'sequence',
          label: 'Block',
          sequence: {
            mode: 'manual',
            items: [
              leaf('c', { audioUrl: ' https://m.test/3.mp3 ' }),
              leaf('d', { audioUrl: 'https://m.test/3.mp3' }),
            ],
            activeItemId: null,
            loop: false,
          },
        },
        leaf('e', { audioUrl: '' }),
      ],
      activeItemId: null,
      loop: false,
    });
    const counts = countProgramSongLeavesBySong(sequence);
    expect(counts.get('song:7')).toEqual({ count: 2, label: 'Artist - Song' });
    expect(counts.get('url:https://m.test/3.mp3')).toEqual({
      count: 2,
      label: 'url:https://m.test/3.mp3',
    });
    expect(counts.size).toBe(2);
    expect(countProgramSongLeavesBySong(null).size).toBe(0);
  });
});

describe('leaf removal helpers (#327)', () => {
  const leaf = (id: string) => ({
    id,
    kind: 'preset' as const,
    artist: id,
    title: id,
    coverUrl: '',
    audioUrl: `https://example.test/${id}.mp3`,
  });
  const make = (activeItemId: string | null, inner: string | null) =>
    ({
      mode: 'autoplay',
      intervalMs: 500,
      loop: true,
      startedAt: 1,
      activeItemId,
      items: [
        leaf('a'),
        {
          id: 'block',
          kind: 'sequence',
          label: 'Block',
          sequence: {
            mode: 'autoplay',
            intervalMs: 500,
            loop: true,
            startedAt: 2,
            activeItemId: inner,
            items: [leaf('b'), leaf('c')],
          },
        },
      ],
    }) as never;

  it('follows the cursor down through nested blocks to the active leaf', () => {
    expect(activeProgramSongLeafId(make('a', null))).toBe('a');
    expect(activeProgramSongLeafId(make('block', 'c'))).toBe('c');
    expect(activeProgramSongLeafId(make('block', null))).toBeNull();
    expect(activeProgramSongLeafId(make('missing', null))).toBeNull();
    expect(activeProgramSongLeafId(make(null, null))).toBeNull();
    expect(activeProgramSongLeafId(null)).toBeNull();
  });

  it('removes leaves at any depth and moves a cursor that pointed at a removed item to the first remaining one', () => {
    const sequence = make('block', 'b') as Tree;
    const removed = removeProgramSongLeavesInPlace(
      sequence,
      new Set(['a', 'b']),
    );
    expect(removed.map((item) => item.id)).toEqual(['a', 'b']);
    expect(sequence.items.map((item: { id: string }) => item.id)).toEqual([
      'block',
    ]);
    expect(
      sequence.items[0].sequence.items.map((item: { id: string }) => item.id),
    ).toEqual(['c']);
    expect(sequence.items[0].sequence.activeItemId).toBe('c');
    expect(sequence.activeItemId).toBe('block');
  });

  it('leaves an untouched cursor and a missing one alone, and stops at the depth limit', () => {
    const sequence = make('a', null) as Tree;
    removeProgramSongLeavesInPlace(sequence, new Set(['c']));
    expect(sequence.activeItemId).toBe('a');
    expect(
      removeProgramSongLeavesInPlace(sequence, new Set(['a']), 99),
    ).toEqual([]);
  });
});
