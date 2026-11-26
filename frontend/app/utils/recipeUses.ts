import type { FlightCue } from "../models/broadcast";

/**
 * gaulatti/alcantara#425 (#222 R4): the operator rundown shows the cues of one recipe use as one row.
 * A use is a run of contiguous cues with the same `recipeUse.useId` (contract C1). These helpers are
 * pure: they turn the rundown's cues into rows and back, and never reorder anything they don't name.
 */
export type RundownRow =
  | { kind: "cue"; cue: FlightCue; index: number }
  | {
      kind: "use";
      useId: string;
      recipeId: number;
      songId: number;
      cues: FlightCue[];
      start: number;
      end: number;
      /** The use's cues are not all together (a hand edit split it); it shows as its parts. */
      partial: boolean;
    };

export function groupRundown(items: FlightCue[]): RundownRow[] {
  const rows: RundownRow[] = [];
  let index = 0;
  while (index < items.length) {
    const tag = items[index].recipeUse;
    if (!tag) {
      rows.push({ kind: "cue", cue: items[index], index });
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < items.length && items[end].recipeUse?.useId === tag.useId) end += 1;
    rows.push({
      kind: "use",
      useId: tag.useId,
      recipeId: tag.recipeId,
      songId: tag.params.songId,
      cues: items.slice(index, end),
      start: index,
      end,
      partial: false,
    });
    index = end;
  }
  // A use is partial when more than one run of its cues made it into the rundown. Counting the rows
  // directly means no lookup can miss: every use row is one of the rows counted.
  return rows.map((row) =>
    row.kind === "use" &&
    rows.filter((other) => other.kind === "use" && other.useId === row.useId).length > 1
      ? { ...row, partial: true }
      : row,
  );
}

/** The same cues, with the use's tag removed: they become ordinary, hand-editable cues. */
export function detachUse(items: FlightCue[], useId: string): FlightCue[] {
  return items.map((cue) => {
    if (cue.recipeUse?.useId !== useId) return cue;
    const { recipeUse: _detached, ...rest } = cue;
    void _detached;
    return rest;
  });
}

/** Replaces the use's cues (contiguous or not) by `cues`, where its first cue was. */
export function replaceUse(items: FlightCue[], useId: string, cues: FlightCue[]): FlightCue[] {
  const first = items.findIndex((cue) => cue.recipeUse?.useId === useId);
  if (first < 0) return items;
  const rest = items.filter((cue) => cue.recipeUse?.useId !== useId);
  const before = items.slice(0, first).filter((cue) => cue.recipeUse?.useId !== useId).length;
  return [...rest.slice(0, before), ...cues, ...rest.slice(before)];
}

/** Removes every cue of the use. */
export function removeUse(items: FlightCue[], useId: string): FlightCue[] {
  return items.filter((cue) => cue.recipeUse?.useId !== useId);
}

/**
 * Moves row `rowIndex` one row up or down, past a whole neighbouring row (a cue or another use), so a
 * use's cues always move together and are never split by a move.
 */
export function moveRow(items: FlightCue[], rowIndex: number, direction: "up" | "down"): FlightCue[] {
  const rows = groupRundown(items);
  const other = direction === "up" ? rowIndex - 1 : rowIndex + 1;
  if (rowIndex < 0 || rowIndex >= rows.length || other < 0 || other >= rows.length) return items;
  const cuesOf = (row: RundownRow) => (row.kind === "cue" ? [row.cue] : row.cues);
  const order = rows.map(cuesOf);
  [order[rowIndex], order[other]] = [order[other], order[rowIndex]];
  return order.flat();
}

/** Inserts cues at `index` (the end when omitted). */
export function insertCues(items: FlightCue[], cues: FlightCue[], index = items.length): FlightCue[] {
  const at = Math.max(0, Math.min(index, items.length));
  return [...items.slice(0, at), ...cues, ...items.slice(at)];
}
