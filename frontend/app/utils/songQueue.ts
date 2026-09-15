import type { ProgramSongQueueEntry } from "../models/broadcast";

const MAX_PROGRAM_SONG_QUEUE_LENGTH = 100;

export function normalizeProgramSongQueue(
  value: unknown,
): ProgramSongQueueEntry[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const normalized: ProgramSongQueueEntry[] = [];
  for (const candidate of value) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const itemId =
      typeof record.itemId === "string" ? record.itemId.trim() : "";
    const enqueuedAt =
      typeof record.enqueuedAt === "number" &&
      Number.isFinite(record.enqueuedAt) &&
      record.enqueuedAt > 0
        ? Math.round(record.enqueuedAt)
        : 0;
    if (!id || !itemId || !enqueuedAt || ids.has(id)) continue;
    ids.add(id);
    normalized.push({ id, itemId, enqueuedAt });
    if (normalized.length >= MAX_PROGRAM_SONG_QUEUE_LENGTH) break;
  }
  return normalized;
}
