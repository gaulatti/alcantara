import {
  findUniqueProgramSongLeafById,
  type ProgramSongSequence,
} from './song-sequence.utils';

export const MAX_PROGRAM_SONG_QUEUE_LENGTH = 100;

export interface ProgramSongQueueEntry {
  id: string;
  itemId: string;
  enqueuedAt: number;
  active?: boolean;
  playbackRequestId?: string;
}

export function normalizeProgramSongQueue(
  value: unknown,
): ProgramSongQueueEntry[] {
  if (!Array.isArray(value)) return [];

  const ids = new Set<string>();
  const normalized: ProgramSongQueueEntry[] = [];
  for (const candidate of value) {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const itemId =
      typeof record.itemId === 'string' ? record.itemId.trim() : '';
    const enqueuedAt =
      typeof record.enqueuedAt === 'number' &&
      Number.isFinite(record.enqueuedAt) &&
      record.enqueuedAt > 0
        ? Math.round(record.enqueuedAt)
        : 0;
    if (!id || !itemId || !enqueuedAt || ids.has(id)) continue;
    const playbackRequestId =
      typeof record.playbackRequestId === 'string' &&
      record.playbackRequestId.trim() &&
      record.playbackRequestId.trim().length <= 128
        ? record.playbackRequestId.trim()
        : '';
    ids.add(id);
    normalized.push({
      id,
      itemId,
      enqueuedAt,
      ...(record.active === true && normalized.length === 0 && playbackRequestId
        ? { active: true, playbackRequestId }
        : {}),
    });
    if (normalized.length >= MAX_PROGRAM_SONG_QUEUE_LENGTH) break;
  }
  return normalized;
}

export function filterProgramSongQueueForSequence(
  queue: ProgramSongQueueEntry[],
  sequence: ProgramSongSequence | null,
): ProgramSongQueueEntry[] {
  if (!sequence) return [];
  return queue.filter((entry) =>
    Boolean(findUniqueProgramSongLeafById(sequence, entry.itemId)?.audioUrl),
  );
}
