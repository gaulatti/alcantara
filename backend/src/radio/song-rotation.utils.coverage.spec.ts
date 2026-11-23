import { normalizeProgramSongSequence } from './song-sequence.utils';
import {
  getHighRotationEligibility,
  HIGH_ROTATION_HISTORY_RETENTION_MS,
  HIGH_ROTATION_INTERVAL_MS,
  highRotationRepeatIntervalMs,
  highRotationSongKey,
  normalizeProgramSongRotation,
  recordHighRotationPlay,
  selectHighRotationCandidate,
} from './song-rotation.utils';

const NOW = Date.parse('2026-09-15T12:00:00.000Z');

function entry(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'r1',
    songKey: 'song:1',
    itemId: 'fav-1',
    playedAt: NOW - 1000,
    ...overrides,
  };
}

describe('high rotation song key', () => {
  it('uses the catalog song id when it is a positive integer', () => {
    expect(highRotationSongKey({ id: 'a', songId: 7 })).toBe('song:7');
  });

  it('falls back to the item id for missing, zero, negative or fractional ids', () => {
    expect(highRotationSongKey({ id: 'a' })).toBe('item:a');
    expect(highRotationSongKey({ id: 'a', songId: 0 })).toBe('item:a');
    expect(highRotationSongKey({ id: 'a', songId: -3 })).toBe('item:a');
    expect(highRotationSongKey({ id: 'a', songId: 1.5 })).toBe('item:a');
  });
});

describe('normalizeProgramSongRotation edge cases', () => {
  it('returns an empty history for non-record input', () => {
    expect(normalizeProgramSongRotation(null, NOW)).toEqual({ history: [] });
    expect(normalizeProgramSongRotation('x', NOW)).toEqual({ history: [] });
    expect(normalizeProgramSongRotation([], NOW)).toEqual({ history: [] });
  });

  it('returns an empty history when history is not an array', () => {
    expect(normalizeProgramSongRotation({ history: 'nope' }, NOW)).toEqual({
      history: [],
    });
    expect(normalizeProgramSongRotation({}, NOW)).toEqual({ history: [] });
  });

  it('defaults the clock to the current time', () => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      expect(
        normalizeProgramSongRotation({ history: [entry()] }).history,
      ).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('skips non-record entries', () => {
    expect(
      normalizeProgramSongRotation(
        { history: [null, 4, 'x', [entry()], entry()] },
        NOW,
      ).history,
    ).toEqual([entry()]);
  });

  it('rejects entries with missing or non-string fields', () => {
    const bad = [
      entry({ requestId: undefined }),
      entry({ requestId: 5 }),
      entry({ requestId: '  ' }),
      entry({ songKey: undefined }),
      entry({ songKey: 5 }),
      entry({ itemId: undefined }),
      entry({ itemId: 5 }),
      entry({ playedAt: undefined }),
      entry({ playedAt: '5' }),
      entry({ playedAt: Number.NaN }),
      entry({ playedAt: Infinity }),
    ];
    expect(normalizeProgramSongRotation({ history: bad }, NOW).history).toEqual(
      [],
    );
  });

  it('rejects overlong identifiers', () => {
    const long = 'x'.repeat(129);
    const ok = 'x'.repeat(128);
    expect(
      normalizeProgramSongRotation(
        {
          history: [
            entry({ requestId: long }),
            entry({ songKey: long }),
            entry({ itemId: long }),
            entry({ requestId: ok }),
          ],
        },
        NOW,
      ).history,
    ).toEqual([entry({ requestId: ok })]);
  });

  it('rejects entries outside the retention window and future skew', () => {
    const earliest = NOW - HIGH_ROTATION_HISTORY_RETENTION_MS;
    const latest = NOW + 5 * 60 * 1000;
    const result = normalizeProgramSongRotation(
      {
        history: [
          entry({ requestId: 'old', playedAt: earliest - 1 }),
          entry({ requestId: 'edge-old', playedAt: earliest }),
          entry({ requestId: 'edge-new', playedAt: latest }),
          entry({ requestId: 'future', playedAt: latest + 1 }),
        ],
      },
      NOW,
    );
    expect(result.history.map((item) => item.requestId)).toEqual([
      'edge-old',
      'edge-new',
    ]);
  });

  it('trims fields, rounds timestamps, dedupes by request id and sorts ascending', () => {
    const result = normalizeProgramSongRotation(
      {
        history: [
          entry({
            requestId: ' a ',
            songKey: ' song:1 ',
            itemId: ' i ',
            playedAt: NOW - 10.4,
          }),
          entry({ requestId: 'b', playedAt: NOW - 500 }),
          entry({ requestId: 'a', playedAt: NOW - 20 }),
        ],
      },
      NOW,
    );
    expect(result.history).toEqual([
      {
        requestId: 'b',
        songKey: 'song:1',
        itemId: 'fav-1',
        playedAt: NOW - 500,
      },
      {
        requestId: 'a',
        songKey: 'song:1',
        itemId: 'fav-1',
        playedAt: NOW - 20,
      },
    ]);
  });

  it('keeps only the latest 256 entries', () => {
    const history = Array.from({ length: 300 }, (_, index) =>
      entry({ requestId: `r${index}`, playedAt: NOW - 400 + index }),
    );
    const result = normalizeProgramSongRotation({ history }, NOW).history;
    expect(result).toHaveLength(256);
    expect(result[0].requestId).toBe('r44');
    expect(result[255].requestId).toBe('r299');
  });
});

describe('high rotation eligibility and interval', () => {
  const song = {
    id: 'fav-1',
    songId: 1,
    highRotation: true,
    artist: 'A',
    title: 'T',
    coverUrl: '',
    activePathLabels: [],
  };

  it('reports cooldown inside the repeat interval and eligible outside it', () => {
    const interval = highRotationRepeatIntervalMs(2);
    expect(
      getHighRotationEligibility(
        song,
        { history: [entry({ playedAt: NOW - interval + 1 })] as never },
        2,
        NOW,
      ),
    ).toBe('cooldown');
    expect(
      getHighRotationEligibility(
        song,
        { history: [entry({ playedAt: NOW - interval })] as never },
        2,
        NOW,
      ),
    ).toBe('eligible');
    expect(getHighRotationEligibility(song, { history: [] }, 2, NOW)).toBe(
      'eligible',
    );
  });

  it('ignores plays of other songs and defaults the clock', () => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      expect(
        getHighRotationEligibility(
          song,
          { history: [entry({ songKey: 'song:2' })] as never },
          2,
        ),
      ).toBe('eligible');
    } finally {
      spy.mockRestore();
    }
  });

  it('bounds the favorite count between 1 and 12 and treats non-finite as 1', () => {
    expect(highRotationRepeatIntervalMs(Number.NaN)).toBe(
      HIGH_ROTATION_INTERVAL_MS,
    );
    expect(highRotationRepeatIntervalMs(Infinity)).toBe(
      HIGH_ROTATION_INTERVAL_MS,
    );
    expect(highRotationRepeatIntervalMs(0)).toBe(HIGH_ROTATION_INTERVAL_MS);
    expect(highRotationRepeatIntervalMs(3.9)).toBe(
      HIGH_ROTATION_INTERVAL_MS * 3,
    );
    expect(highRotationRepeatIntervalMs(99)).toBe(
      HIGH_ROTATION_INTERVAL_MS * 12,
    );
  });
});

describe('selectHighRotationCandidate edge cases', () => {
  function favorites(items: Array<Record<string, unknown>>) {
    return normalizeProgramSongSequence({
      mode: 'shuffle',
      items: items.map((item) => ({
        kind: 'preset',
        title: 'T',
        artist: 'A',
        coverUrl: '',
        audioUrl: 'https://example.test/x.mp3',
        ...item,
      })),
    });
  }

  it('is not due for a missing sequence or one without favorites', () => {
    expect(selectHighRotationCandidate(null, { history: [] }, NOW)).toEqual({
      song: null,
      status: 'not-due',
    });
    expect(
      selectHighRotationCandidate(
        favorites([{ id: 'plain' }]),
        { history: [] },
        NOW,
      ),
    ).toEqual({ song: null, status: 'not-due' });
  });

  it('ignores history for non-favorite songs and defaults the clock', () => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      const result = selectHighRotationCandidate(
        favorites([{ id: 'f1', songId: 1, highRotation: true }]),
        {
          history: [entry({ songKey: 'song:99', playedAt: NOW - 1 })] as never,
        },
      );
      expect(result.status).toBe('selected');
      expect(result.song?.id).toBe('f1');
    } finally {
      spy.mockRestore();
    }
  });

  it('reports quota-unmet when every favorite is still cooling down', () => {
    const sequence = favorites([
      { id: 'f1', songId: 1, highRotation: true },
      { id: 'f2', songId: 2, highRotation: true },
    ]);
    const playedAt = NOW - 1.5 * HIGH_ROTATION_INTERVAL_MS;
    expect(
      selectHighRotationCandidate(
        sequence,
        {
          history: [
            entry({ requestId: 'a', songKey: 'song:1', playedAt }),
            entry({ requestId: 'b', songKey: 'song:2', playedAt }),
          ] as never,
        },
        NOW,
      ),
    ).toEqual({ song: null, status: 'quota-unmet' });
  });

  it('prefers the favorite that was never played, then the least recently played', () => {
    const sequence = favorites([
      { id: 'f1', songId: 1, highRotation: true },
      { id: 'f2', songId: 2, highRotation: true },
    ]);
    const old = NOW - 10 * HIGH_ROTATION_INTERVAL_MS;
    const older = NOW - 12 * HIGH_ROTATION_INTERVAL_MS;
    const never = selectHighRotationCandidate(
      sequence,
      {
        history: [
          entry({ requestId: 'a', songKey: 'song:1', playedAt: old }),
        ] as never,
      },
      NOW,
    );
    expect(never.song?.id).toBe('f2');
    const leastRecent = selectHighRotationCandidate(
      sequence,
      {
        history: [
          entry({ requestId: 'a', songKey: 'song:1', playedAt: old }),
          entry({ requestId: 'b', songKey: 'song:2', playedAt: older }),
        ] as never,
      },
      NOW,
    );
    expect(leastRecent.song?.id).toBe('f2');
    const swapped = selectHighRotationCandidate(
      sequence,
      {
        history: [
          entry({ requestId: 'a', songKey: 'song:1', playedAt: older }),
          entry({ requestId: 'b', songKey: 'song:2', playedAt: old }),
        ] as never,
      },
      NOW,
    );
    expect(swapped.song?.id).toBe('f1');
  });
});

describe('recordHighRotationPlay edge cases', () => {
  it('does not add a request id that is already recorded', () => {
    const state = { history: [entry({ requestId: 'dup' })] as never };
    const result = recordHighRotationPlay(
      state,
      { id: 'fav-1', songId: 1 },
      'dup',
      NOW,
    );
    expect(result.added).toBe(false);
    expect(result.state.history).toHaveLength(1);
  });

  it('records a new play keyed by the item when it has no song id', () => {
    const result = recordHighRotationPlay(
      { history: [] },
      { id: 'fav-9' },
      'req-9',
      NOW,
    );
    expect(result).toEqual({
      added: true,
      state: {
        history: [
          {
            requestId: 'req-9',
            songKey: 'item:fav-9',
            itemId: 'fav-9',
            playedAt: NOW,
          },
        ],
      },
    });
  });

  it('defaults playedAt to the current time', () => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      const result = recordHighRotationPlay(
        { history: [] },
        { id: 'fav-1', songId: 1 },
        'req-1',
      );
      expect(result.state.history[0].playedAt).toBe(NOW);
    } finally {
      spy.mockRestore();
    }
  });
});
