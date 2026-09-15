import {
  filterProgramSongQueueForSequence,
  normalizeProgramSongQueue,
} from './song-queue.utils';
import { normalizeProgramSongSequence } from './song-sequence.utils';

describe('program song queue', () => {
  it('keeps ordered duplicate song references with unique queue entry IDs', () => {
    expect(
      normalizeProgramSongQueue([
        { id: 'queue-1', itemId: 'song-1', enqueuedAt: 1 },
        { id: 'queue-2', itemId: 'song-1', enqueuedAt: 2 },
      ]),
    ).toEqual([
      { id: 'queue-1', itemId: 'song-1', enqueuedAt: 1 },
      { id: 'queue-2', itemId: 'song-1', enqueuedAt: 2 },
    ]);
  });

  it('keeps a bounded request identity only on the claimed queue head', () => {
    expect(
      normalizeProgramSongQueue([
        {
          id: 'queue-1',
          itemId: 'song-1',
          enqueuedAt: 1,
          active: true,
          playbackRequestId: 'request-1',
        },
        {
          id: 'queue-2',
          itemId: 'song-2',
          enqueuedAt: 2,
          active: true,
          playbackRequestId: 'request-2',
        },
      ]),
    ).toEqual([
      {
        id: 'queue-1',
        itemId: 'song-1',
        enqueuedAt: 1,
        active: true,
        playbackRequestId: 'request-1',
      },
      { id: 'queue-2', itemId: 'song-2', enqueuedAt: 2 },
    ]);
  });

  it('removes queue entries whose playable playlist item no longer exists', () => {
    const sequence = normalizeProgramSongSequence({
      mode: 'shuffle',
      items: [
        {
          id: 'song-1',
          kind: 'preset',
          artist: 'Artist',
          title: 'Song',
          coverUrl: '',
          audioUrl: 'https://media.test/song.mp3',
        },
      ],
    });
    const queue = normalizeProgramSongQueue([
      { id: 'queue-1', itemId: 'song-1', enqueuedAt: 1 },
      { id: 'queue-2', itemId: 'missing', enqueuedAt: 2 },
    ]);

    expect(filterProgramSongQueueForSequence(queue, sequence)).toEqual([
      { id: 'queue-1', itemId: 'song-1', enqueuedAt: 1 },
    ]);
  });
});
