import {
  filterProgramSongQueueForSequence,
  MAX_PROGRAM_SONG_QUEUE_LENGTH,
  normalizeProgramSongQueue,
} from './song-queue.utils';
import { normalizeProgramSongSequence } from './song-sequence.utils';

describe('program song queue edge cases', () => {
  it('returns an empty queue for non-array input', () => {
    expect(normalizeProgramSongQueue(undefined)).toEqual([]);
    expect(normalizeProgramSongQueue({ id: 'queue-1' })).toEqual([]);
    expect(normalizeProgramSongQueue('queue')).toEqual([]);
  });

  it('skips candidates that are not plain objects', () => {
    expect(
      normalizeProgramSongQueue([
        null,
        0,
        'text',
        ['array'],
        { id: 'queue-1', itemId: 'song-1', enqueuedAt: 5 },
      ]),
    ).toEqual([{ id: 'queue-1', itemId: 'song-1', enqueuedAt: 5 }]);
  });

  it('skips candidates with missing, non-string or blank ids and item ids', () => {
    expect(
      normalizeProgramSongQueue([
        { itemId: 'song-1', enqueuedAt: 1 },
        { id: 7, itemId: 'song-1', enqueuedAt: 1 },
        { id: '   ', itemId: 'song-1', enqueuedAt: 1 },
        { id: 'queue-1', enqueuedAt: 1 },
        { id: 'queue-1', itemId: 7, enqueuedAt: 1 },
        { id: 'queue-1', itemId: '  ', enqueuedAt: 1 },
      ]),
    ).toEqual([]);
  });

  it('skips candidates with invalid timestamps', () => {
    expect(
      normalizeProgramSongQueue([
        { id: 'a', itemId: 'song-1' },
        { id: 'b', itemId: 'song-1', enqueuedAt: '5' },
        { id: 'c', itemId: 'song-1', enqueuedAt: Number.NaN },
        { id: 'd', itemId: 'song-1', enqueuedAt: Infinity },
        { id: 'e', itemId: 'song-1', enqueuedAt: 0 },
        { id: 'f', itemId: 'song-1', enqueuedAt: -3 },
      ]),
    ).toEqual([]);
  });

  it('trims ids, rounds timestamps and drops duplicate queue ids', () => {
    expect(
      normalizeProgramSongQueue([
        { id: ' q1 ', itemId: ' s1 ', enqueuedAt: 1.6 },
        { id: 'q1', itemId: 's2', enqueuedAt: 2 },
      ]),
    ).toEqual([{ id: 'q1', itemId: 's1', enqueuedAt: 2 }]);
  });

  it('drops the active flag unless the head has a bounded request id', () => {
    const tooLong = 'x'.repeat(129);
    expect(
      normalizeProgramSongQueue([
        { id: 'q1', itemId: 's1', enqueuedAt: 1, active: true },
        {
          id: 'q2',
          itemId: 's2',
          enqueuedAt: 2,
          active: true,
          playbackRequestId: 'r2',
        },
      ]),
    ).toEqual([
      { id: 'q1', itemId: 's1', enqueuedAt: 1 },
      { id: 'q2', itemId: 's2', enqueuedAt: 2 },
    ]);
    expect(
      normalizeProgramSongQueue([
        {
          id: 'q1',
          itemId: 's1',
          enqueuedAt: 1,
          active: true,
          playbackRequestId: tooLong,
        },
      ]),
    ).toEqual([{ id: 'q1', itemId: 's1', enqueuedAt: 1 }]);
    expect(
      normalizeProgramSongQueue([
        {
          id: 'q1',
          itemId: 's1',
          enqueuedAt: 1,
          active: true,
          playbackRequestId: '   ',
        },
        {
          id: 'q2',
          itemId: 's2',
          enqueuedAt: 2,
          active: true,
          playbackRequestId: 42,
        },
      ]),
    ).toEqual([
      { id: 'q1', itemId: 's1', enqueuedAt: 1 },
      { id: 'q2', itemId: 's2', enqueuedAt: 2 },
    ]);
    expect(
      normalizeProgramSongQueue([
        {
          id: 'q1',
          itemId: 's1',
          enqueuedAt: 1,
          active: false,
          playbackRequestId: 'r1',
        },
      ]),
    ).toEqual([{ id: 'q1', itemId: 's1', enqueuedAt: 1 }]);
  });

  it('keeps the trimmed request id on the active head', () => {
    expect(
      normalizeProgramSongQueue([
        {
          id: 'q1',
          itemId: 's1',
          enqueuedAt: 1,
          active: true,
          playbackRequestId: ' r1 ',
        },
      ]),
    ).toEqual([
      {
        id: 'q1',
        itemId: 's1',
        enqueuedAt: 1,
        active: true,
        playbackRequestId: 'r1',
      },
    ]);
  });

  it('caps the queue at the maximum length', () => {
    const input = Array.from(
      { length: MAX_PROGRAM_SONG_QUEUE_LENGTH + 20 },
      (_, index) => ({
        id: `q${index}`,
        itemId: 's1',
        enqueuedAt: index + 1,
      }),
    );
    const result = normalizeProgramSongQueue(input);
    expect(result).toHaveLength(MAX_PROGRAM_SONG_QUEUE_LENGTH);
    expect(result[MAX_PROGRAM_SONG_QUEUE_LENGTH - 1].id).toBe(
      `q${MAX_PROGRAM_SONG_QUEUE_LENGTH - 1}`,
    );
  });

  it('returns no entries when there is no sequence', () => {
    expect(
      filterProgramSongQueueForSequence(
        [{ id: 'q1', itemId: 's1', enqueuedAt: 1 }],
        null,
      ),
    ).toEqual([]);
  });

  it('drops entries whose song has no audio URL', () => {
    const sequence = normalizeProgramSongSequence({
      mode: 'shuffle',
      items: [
        {
          id: 's1',
          kind: 'preset',
          artist: 'A',
          title: 'T',
          coverUrl: '',
          audioUrl: '',
        },
      ],
    });
    expect(
      filterProgramSongQueueForSequence(
        [{ id: 'q1', itemId: 's1', enqueuedAt: 1 }],
        sequence,
      ),
    ).toEqual([]);
  });
});
