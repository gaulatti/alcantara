import {
  normalizeProgramSongSequence,
  resolveProgramSongLeaf,
} from './song-sequence.utils';

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
});
