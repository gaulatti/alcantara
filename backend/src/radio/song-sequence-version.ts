import { createHash } from 'node:crypto';
import {
  normalizeProgramSongSequence,
  programSongSequenceStructure,
} from './song-sequence.utils';

/** The refusal a save of the rotation gets when it was not made from the rotation now stored. */
export const ROTATION_CHANGED_MESSAGE =
  "The rotation changed or didn't load: reload before saving";

/**
 * Normalising names an item that has no id after the clock, so a rotation stored without ids would get a new version
 * on every read and could never be saved. Each such item is named after its place instead.
 */
function withStableIds(value: unknown, path: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.items)) return record;
  return {
    ...record,
    items: record.items.map((item: unknown, index) => {
      if (!item || typeof item !== 'object') return item;
      const entry = item as Record<string, unknown>;
      const place = `${path}.${index}`;
      return {
        ...entry,
        id: typeof entry.id === 'string' && entry.id ? entry.id : place,
        ...(entry.kind === 'sequence'
          ? { sequence: withStableIds(entry.sequence, place) }
          : {}),
      };
    }),
  };
}

/**
 * The version of a stored rotation: a hash of its playlist and mode. The cursor and its clock are left out, because
 * the engine moves them while the rotation plays and that is not an edit.
 */
export function programSongSequenceVersion(stored: unknown): string {
  const structure = programSongSequenceStructure(
    normalizeProgramSongSequence(withStableIds(stored, 'item')),
  );
  return createHash('sha256').update(structure).digest('hex').slice(0, 16);
}
