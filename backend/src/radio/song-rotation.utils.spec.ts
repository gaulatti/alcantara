import { normalizeProgramSongSequence } from './song-sequence.utils';
import {
  getHighRotationEligibility,
  HIGH_ROTATION_COOLDOWN_MS,
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

  it('never selects the same favorite twice inside six hours', () => {
    const selectedSequence = sequence(1);
    const favorite = selectedSequence?.items[1];
    expect(favorite?.kind).toBe('preset');
    if (!selectedSequence || !favorite || favorite.kind !== 'preset') return;

    expect(
      getHighRotationEligibility(
        { ...favorite, activePathLabels: [] },
        history([
          {
            songId: 1,
            playedAt: NOW - HIGH_ROTATION_COOLDOWN_MS + 1,
          },
        ]),
        NOW,
      ),
    ).toBe('cooldown');
    expect(
      selectHighRotationCandidate(
        selectedSequence,
        history([{ songId: 1, playedAt: NOW - HOUR }]),
        NOW,
      ).status,
    ).toBe('quota-unmet');
  });

  it('caps a favorite at four plays in a rolling 24 hours', () => {
    const selectedSequence = sequence(1);
    const favorite = selectedSequence?.items[1];
    expect(favorite?.kind).toBe('preset');
    if (!favorite || favorite.kind !== 'preset') return;

    expect(
      getHighRotationEligibility(
        { ...favorite, activePathLabels: [] },
        history(
          [6, 12, 18, 23].map((hours) => ({
            songId: 1,
            playedAt: NOW - hours * HOUR,
          })),
        ),
        NOW,
      ),
    ).toBe('daily-cap');
  });

  it('reports an unmet quota instead of illegally repeating a smaller favorite pool', () => {
    const entries = Array.from({ length: 11 }, (_, index) => ({
      songId: index + 1,
      playedAt: NOW - HOUR,
    }));
    expect(
      selectHighRotationCandidate(sequence(11), history(entries), NOW),
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
