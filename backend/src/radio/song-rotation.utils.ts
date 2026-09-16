import {
  collectHighRotationProgramSongLeaves,
  type ProgramResolvedSongLeaf,
  type ProgramSongSequence,
} from './song-sequence.utils';

export const MAX_HIGH_ROTATION_SONGS = 12;
export const HIGH_ROTATION_TARGET_PER_HOUR = 2;
export const HIGH_ROTATION_INTERVAL_MS =
  (60 * 60 * 1000) / HIGH_ROTATION_TARGET_PER_HOUR;
export const HIGH_ROTATION_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const HIGH_ROTATION_DAILY_LIMIT = 4;
export const HIGH_ROTATION_HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_ROTATION_HISTORY_ENTRIES = 256;

export interface ProgramSongRotationHistoryEntry {
  requestId: string;
  songKey: string;
  itemId: string;
  playedAt: number;
}

export interface ProgramSongRotationState {
  history: ProgramSongRotationHistoryEntry[];
}

export type HighRotationEligibility = 'eligible' | 'cooldown' | 'daily-cap';
export type HighRotationSelectionStatus =
  | 'selected'
  | 'not-due'
  | 'quota-unmet';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function highRotationSongKey(song: {
  id: string;
  songId?: number;
}): string {
  return Number.isInteger(song.songId) && (song.songId as number) > 0
    ? `song:${song.songId}`
    : `item:${song.id}`;
}

export function normalizeProgramSongRotation(
  value: unknown,
  now = Date.now(),
): ProgramSongRotationState {
  const record = asRecord(value);
  const rawHistory = Array.isArray(record?.history) ? record.history : [];
  const earliest = now - HIGH_ROTATION_HISTORY_RETENTION_MS;
  const latest = now + 5 * 60 * 1000;
  const byRequestId = new Map<string, ProgramSongRotationHistoryEntry>();

  for (const rawEntry of rawHistory) {
    const entry = asRecord(rawEntry);
    if (!entry) continue;
    const requestId =
      typeof entry.requestId === 'string' ? entry.requestId.trim() : '';
    const songKey =
      typeof entry.songKey === 'string' ? entry.songKey.trim() : '';
    const itemId = typeof entry.itemId === 'string' ? entry.itemId.trim() : '';
    const playedAt =
      typeof entry.playedAt === 'number' && Number.isFinite(entry.playedAt)
        ? Math.round(entry.playedAt)
        : NaN;
    if (
      !requestId ||
      requestId.length > 128 ||
      !songKey ||
      songKey.length > 128 ||
      !itemId ||
      itemId.length > 128 ||
      !Number.isFinite(playedAt) ||
      playedAt < earliest ||
      playedAt > latest
    ) {
      continue;
    }
    byRequestId.set(requestId, { requestId, songKey, itemId, playedAt });
  }

  return {
    history: [...byRequestId.values()]
      .sort((a, b) => a.playedAt - b.playedAt)
      .slice(-MAX_ROTATION_HISTORY_ENTRIES),
  };
}

export function getHighRotationEligibility(
  song: ProgramResolvedSongLeaf,
  rotation: ProgramSongRotationState,
  now = Date.now(),
): HighRotationEligibility {
  const songKey = highRotationSongKey(song);
  const plays = rotation.history.filter((entry) => entry.songKey === songKey);
  if (plays.some((entry) => now - entry.playedAt < HIGH_ROTATION_COOLDOWN_MS)) {
    return 'cooldown';
  }
  if (
    plays.filter(
      (entry) => now - entry.playedAt < HIGH_ROTATION_HISTORY_RETENTION_MS,
    ).length >= HIGH_ROTATION_DAILY_LIMIT
  ) {
    return 'daily-cap';
  }
  return 'eligible';
}

export function selectHighRotationCandidate(
  sequence: ProgramSongSequence | null,
  rotation: ProgramSongRotationState,
  now = Date.now(),
): {
  song: ProgramResolvedSongLeaf | null;
  status: HighRotationSelectionStatus;
} {
  const favorites = collectHighRotationProgramSongLeaves(sequence);
  if (!favorites.length) return { song: null, status: 'not-due' };
  const favoriteKeys = new Set(favorites.map(highRotationSongKey));
  const latestFavoritePlay = rotation.history.reduce(
    (latest, entry) =>
      favoriteKeys.has(entry.songKey)
        ? Math.max(latest, entry.playedAt)
        : latest,
    Number.NEGATIVE_INFINITY,
  );
  if (now - latestFavoritePlay < HIGH_ROTATION_INTERVAL_MS) {
    return { song: null, status: 'not-due' };
  }

  const eligible = favorites.filter(
    (song) => getHighRotationEligibility(song, rotation, now) === 'eligible',
  );
  if (!eligible.length) return { song: null, status: 'quota-unmet' };

  const lastPlayedAt = (song: ProgramResolvedSongLeaf): number => {
    const key = highRotationSongKey(song);
    return rotation.history.reduce(
      (latest, entry) =>
        entry.songKey === key ? Math.max(latest, entry.playedAt) : latest,
      Number.NEGATIVE_INFINITY,
    );
  };
  eligible.sort((a, b) => lastPlayedAt(a) - lastPlayedAt(b));
  return { song: eligible[0] ?? null, status: 'selected' };
}

export function recordHighRotationPlay(
  rotation: ProgramSongRotationState,
  song: { id: string; songId?: number },
  requestId: string,
  playedAt = Date.now(),
): { state: ProgramSongRotationState; added: boolean } {
  const normalized = normalizeProgramSongRotation(rotation, playedAt);
  if (normalized.history.some((entry) => entry.requestId === requestId)) {
    return { state: normalized, added: false };
  }
  return {
    state: normalizeProgramSongRotation(
      {
        history: [
          ...normalized.history,
          {
            requestId,
            songKey: highRotationSongKey(song),
            itemId: song.id,
            playedAt,
          },
        ],
      },
      playedAt,
    ),
    added: true,
  };
}
