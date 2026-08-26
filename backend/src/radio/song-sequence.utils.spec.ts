import {
  findUniqueProgramSongLeafByAudioUrl,
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
