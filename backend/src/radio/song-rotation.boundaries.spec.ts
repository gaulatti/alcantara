import {
  collectHighRotationProgramSongLeaves,
  normalizeProgramSongSequence,
} from './song-sequence.utils';
import {
  getHighRotationEligibility,
  HIGH_ROTATION_HISTORY_RETENTION_MS,
  highRotationSongKey,
  normalizeProgramSongRotation,
  recordHighRotationPlay,
  selectHighRotationCandidate,
} from './song-rotation.utils';

const now = Date.parse('2026-10-24T12:00:00Z');
const entry = {
  requestId: 'request',
  songKey: 'song:1',
  itemId: 'one',
  playedAt: now,
};
const sequence = () =>
  normalizeProgramSongSequence({
    mode: 'shuffle',
    items: [1, 2].map((songId) => ({
      kind: 'preset',
      id: `favorite-${songId}`,
      songId,
      artist: 'Fixture',
      title: `Song ${songId}`,
      audioUrl: `https://media.invalid/${songId}`,
      coverUrl: '',
      highRotation: true,
    })),
  });

describe('rotation persistence and current-time selection boundaries', () => {
  beforeEach(() => jest.useFakeTimers({ now }));
  afterEach(() => jest.useRealTimers());
  it.each([null, [], false, 'entry', 4].map((value) => [value]))(
    'discards malformed rotation entry %j',
    (value) => {
      expect(normalizeProgramSongRotation({ history: [value, entry] })).toEqual(
        { history: [entry] },
      );
    },
  );
  it.each([
    { requestId: 4 },
    { requestId: ' ' },
    { requestId: 'x'.repeat(129) },
    { songKey: 4 },
    { songKey: '' },
    { songKey: 'x'.repeat(129) },
    { itemId: 4 },
    { itemId: '' },
    { itemId: 'x'.repeat(129) },
    { playedAt: 'now' },
    { playedAt: Infinity },
    { playedAt: now - HIGH_ROTATION_HISTORY_RETENTION_MS - 1 },
    { playedAt: now + 5 * 60_000 + 1 },
  ])(
    'discards invalid, expired or excessively future persisted history %j',
    (override) => {
      expect(
        normalizeProgramSongRotation({ history: [{ ...entry, ...override }] }),
      ).toEqual({ history: [] });
    },
  );
  it('uses item identity when no positive canonical song ID exists', () => {
    expect(highRotationSongKey({ id: 'custom' })).toBe('item:custom');
    expect(highRotationSongKey({ id: 'custom', songId: 0 })).toBe(
      'item:custom',
    );
    expect(highRotationSongKey({ id: 'custom', songId: 1.5 })).toBe(
      'item:custom',
    );
  });
  it('uses the clock default consistently and ignores unrelated song history when choosing an overdue favorite', () => {
    const favorites = collectHighRotationProgramSongLeaves(sequence());
    expect(favorites).toHaveLength(2);
    const old = { ...entry, playedAt: now - 7 * 3_600_000 };
    const unrelated = {
      requestId: 'unrelated',
      songKey: 'song:9',
      itemId: 'foreign',
      playedAt: now,
    };
    const rotation = { history: [old, unrelated] };
    expect(getHighRotationEligibility(favorites[0], rotation, 2)).toBe(
      'eligible',
    );
    expect(selectHighRotationCandidate(sequence(), rotation)).toMatchObject({
      status: 'selected',
      song: { id: 'favorite-2' },
    });
    const recorded = recordHighRotationPlay(
      { history: [] },
      { id: 'custom' },
      'new',
    );
    expect(recorded).toEqual({
      added: true,
      state: {
        history: [
          {
            requestId: 'new',
            songKey: 'item:custom',
            itemId: 'custom',
            playedAt: now,
          },
        ],
      },
    });
  });
});
