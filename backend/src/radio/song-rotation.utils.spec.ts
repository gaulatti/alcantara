import { normalizeProgramSongSequence } from './song-sequence.utils';
import {
  getHighRotationEligibility,
  HIGH_ROTATION_INTERVAL_MS,
  HIGH_ROTATION_MINIMUM_PLAYS_PER_DAY,
  HIGH_ROTATION_OPPORTUNITIES_PER_DAY,
  highRotationRepeatIntervalMs,
  normalizeProgramSongRotation,
  recordHighRotationPlay,
  selectHighRotationCandidate,
} from './song-rotation.utils';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-15T12:00:00.000Z');

function sequence(favoriteCount = 12) {
  return normalizeProgramSongSequence({
    mode: 'shuffle',
    loop: true,
    activeItemId: 'normal',
    items: [
      {
        id: 'normal',
        kind: 'preset',
        title: 'Normal',
        artist: 'Artist',
        coverUrl: '',
        audioUrl: 'https://example.test/normal.mp3',
      },
      ...Array.from({ length: favoriteCount }, (_, index) => ({
        id: `favorite-${index + 1}`,
        kind: 'preset',
        songId: index + 1,
        highRotation: true,
        title: `Favorite ${index + 1}`,
        artist: 'Artist',
        coverUrl: '',
        audioUrl: `https://example.test/favorite-${index + 1}.mp3`,
      })),
    ],
  });
}

function history(
  entries: Array<{ songId: number; playedAt: number; requestId?: string }>,
) {
  return normalizeProgramSongRotation(
    {
      history: entries.map((entry, index) => ({
        requestId: entry.requestId ?? `request-${index}`,
        songKey: `song:${entry.songId}`,
        itemId: `favorite-${entry.songId}`,
        playedAt: entry.playedAt,
      })),
    },
    NOW,
  );
}

describe('radio high rotation scheduling', () => {
  it('selects an eligible favorite while the trailing hour has fewer than two plays', () => {
    const selected = selectHighRotationCandidate(
      sequence(),
      history([{ songId: 1, playedAt: NOW - 7 * HOUR }]),
      NOW,
    );

    expect(selected.status).toBe('selected');
    expect(selected.song).toMatchObject({ id: 'favorite-2' });
  });

  it('returns to normal playlist selection until the next 30-minute opportunity', () => {
    const selected = selectHighRotationCandidate(
      sequence(),
      history([
        { songId: 1, playedAt: NOW - 50 * 60 * 1000 },
        { songId: 2, playedAt: NOW - 10 * 60 * 1000 },
      ]),
      NOW,
    );

    expect(selected).toEqual({ song: null, status: 'not-due' });
  });

  it('scales the repeat gap to the number of favorites', () => {
    expect(highRotationRepeatIntervalMs(4)).toBe(2 * HOUR);
    expect(highRotationRepeatIntervalMs(12)).toBe(6 * HOUR);

    const selectedSequence = sequence(4);
    const favorite = selectedSequence?.items[1];
    expect(favorite?.kind).toBe('preset');
    if (!selectedSequence || !favorite || favorite.kind !== 'preset') return;

    expect(
      getHighRotationEligibility(
        { ...favorite, activePathLabels: [] },
        history([
          {
            songId: 1,
            playedAt: NOW - 2 * HOUR + 1,
          },
        ]),
        4,
        NOW,
      ),
    ).toBe('cooldown');
    expect(
      getHighRotationEligibility(
        { ...favorite, activePathLabels: [] },
        history([{ songId: 1, playedAt: NOW - 2 * HOUR }]),
        4,
        NOW,
      ),
    ).toBe('eligible');
  });

  it.each(
    Array.from({ length: 12 }, (_, index) => ({
      favoriteCount: index + 1,
    })),
  )(
    'distributes daily slots fairly across $favoriteCount favorites',
    ({ favoriteCount }) => {
      const selectedSequence = sequence(favoriteCount);
      expect(selectedSequence).not.toBeNull();
      if (!selectedSequence) return;
      let rotation = normalizeProgramSongRotation(null, NOW);
      const plays = new Map<string, number>();

      for (
        let slot = 0;
        slot < HIGH_ROTATION_OPPORTUNITIES_PER_DAY;
        slot += 1
      ) {
        const playedAt = NOW + slot * HIGH_ROTATION_INTERVAL_MS;
        const selected = selectHighRotationCandidate(
          selectedSequence,
          rotation,
          playedAt,
        );
        expect(selected.status).toBe('selected');
        expect(selected.song).not.toBeNull();
        if (!selected.song) return;
        plays.set(selected.song.id, (plays.get(selected.song.id) ?? 0) + 1);
        rotation = recordHighRotationPlay(
          rotation,
          selected.song,
          `request-${slot}`,
          playedAt,
        ).state;
      }

      const playCounts = [...plays.values()];
      expect(playCounts).toHaveLength(favoriteCount);
      expect(Math.min(...playCounts)).toBeGreaterThanOrEqual(
        HIGH_ROTATION_MINIMUM_PLAYS_PER_DAY,
      );
      expect(Math.min(...playCounts)).toBe(
        Math.floor(HIGH_ROTATION_OPPORTUNITIES_PER_DAY / favoriteCount),
      );
      expect(Math.max(...playCounts)).toBe(
        Math.ceil(HIGH_ROTATION_OPPORTUNITIES_PER_DAY / favoriteCount),
      );
    },
  );

  it('reports an unmet slot when recent operator plays make every favorite temporarily ineligible', () => {
    const entries = Array.from({ length: 4 }, (_, index) => ({
      songId: index + 1,
      playedAt: NOW - HOUR,
    }));
    expect(
      selectHighRotationCandidate(sequence(4), history(entries), NOW),
    ).toEqual({ song: null, status: 'quota-unmet' });
  });

  it('records each authoritative playback request exactly once', () => {
    const selectedSequence = sequence(1);
    const favorite = selectedSequence?.items[1];
    expect(favorite?.kind).toBe('preset');
    if (!favorite || favorite.kind !== 'preset') return;
    const song = { id: favorite.id, songId: favorite.songId };

    const first = recordHighRotationPlay(
      normalizeProgramSongRotation(null, NOW),
      song,
      'request-1',
      NOW,
    );
    const duplicate = recordHighRotationPlay(
      first.state,
      song,
      'request-1',
      NOW,
    );

    expect(first.added).toBe(true);
    expect(duplicate.added).toBe(false);
    expect(duplicate.state.history).toHaveLength(1);
  });
});
