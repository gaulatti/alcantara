type RecordValue = Record<string, unknown>;
const MAX_DEPTH = 8;

export type ProgramSequenceMode = 'manual' | 'autoplay' | 'shuffle';

interface BaseSequenceItem {
  id: string;
}

interface BaseSequence<TItem extends BaseSequenceItem> {
  mode: ProgramSequenceMode;
  items: TItem[];
  activeItemId: string | null;
  intervalMs: number;
  loop: boolean;
  startedAt: number;
  /** The item ids in the order shuffle plays them. `items` stays the operator's own order. */
  shuffleOrder?: string[];
}

export interface ProgramSongSequenceLeafItem extends BaseSequenceItem {
  kind: 'preset';
  songId?: number;
  highRotation?: boolean;
  artist: string;
  title: string;
  coverUrl: string;
  audioUrl?: string;
  durationMs?: number;
  earoneSongId?: string;
  earoneRank?: string;
  earoneSpins?: string;
}

export interface ProgramSongSequenceNestedItem extends BaseSequenceItem {
  label: string;
  kind: 'sequence';
  sequence: ProgramSongSequence;
}

export type ProgramSongSequenceItem =
  | ProgramSongSequenceLeafItem
  | ProgramSongSequenceNestedItem;

export type ProgramSongSequence = BaseSequence<ProgramSongSequenceItem> & {
  /**
   * When a rotation that does not loop ran out (walk part 4): the engine turned it manual then, and any start clears
   * it. Absent on a rotation that did not end, and on one stored before the field existed.
   */
  endedAt?: number;
};

export interface ProgramResolvedSongLeaf {
  id: string;
  songId?: number;
  highRotation: boolean;
  artist: string;
  title: string;
  coverUrl: string;
  audioUrl?: string;
  durationMs?: number;
  earoneSongId?: string;
  earoneRank?: string;
  earoneSpins?: string;
  activePathLabels: string[];
}

function asRecord(value: unknown): RecordValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as RecordValue;
}

function normalizeMode(value: unknown): ProgramSequenceMode {
  if (value === 'shuffle') return 'shuffle';
  if (value === 'manual') return 'manual';
  return 'autoplay';
}

/**
 * The items in the order the rotation plays them: in shuffle, the stored shuffled order (an item added since plays
 * after it); otherwise the operator's order.
 */
export function programSongPlayOrder(
  sequence: ProgramSongSequence,
): ProgramSongSequenceItem[] {
  const order = sequence.shuffleOrder;
  if (sequence.mode !== 'shuffle' || !order?.length) return sequence.items;
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...sequence.items].sort(
    (a, b) =>
      (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length),
  );
}

type SequenceAdvanceResult = 'advanced' | 'exhausted' | 'not-found';

function resetSequenceCursor(sequence: ProgramSongSequence): void {
  const first = programSongPlayOrder(sequence)[0] ?? null;
  sequence.activeItemId = first?.id ?? null;
  if (first?.kind === 'sequence') resetSequenceCursor(first.sequence);
}

function advanceSequenceCursor(
  sequence: ProgramSongSequence,
  activeLeafId: string,
): SequenceAdvanceResult {
  const items = programSongPlayOrder(sequence);
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    let found = item.kind === 'preset' && item.id === activeLeafId;

    if (item.kind === 'sequence') {
      const nestedResult = advanceSequenceCursor(item.sequence, activeLeafId);
      if (nestedResult === 'advanced') return 'advanced';
      found = nestedResult === 'exhausted';
    }

    if (!found) continue;

    const next = items[index + 1] ?? null;
    if (next) {
      sequence.activeItemId = next.id;
      sequence.startedAt = Date.now();
      if (next.kind === 'sequence') resetSequenceCursor(next.sequence);
      return 'advanced';
    }

    if (sequence.loop !== false && sequence.items.length > 0) {
      resetSequenceCursor(sequence);
      sequence.startedAt = Date.now();
      return 'advanced';
    }

    sequence.activeItemId = null;
    return 'exhausted';
  }

  return 'not-found';
}

/** Advances after an authoritative track end and reports whether a successor exists. */
export function advanceProgramSongSequence(
  sequence: ProgramSongSequence,
  activeLeafId?: string | null,
): boolean {
  const leafId = activeLeafId?.trim();
  if (leafId) {
    const result = advanceSequenceCursor(sequence, leafId);
    if (result !== 'not-found') return result === 'advanced';
  }

  const items = programSongPlayOrder(sequence);
  const activeIndex = items.findIndex(
    (item) => item.id === sequence.activeItemId,
  );
  if (activeIndex < 0) {
    // Autoplay must not stop because a browser/manual handoff persisted a
    // stale or empty cursor. A looped sequence always has a valid recovery
    // target: its first playable branch.
    if (sequence.loop !== false && sequence.items.length > 0) {
      resetSequenceCursor(sequence);
      sequence.startedAt = Date.now();
      return true;
    }
    return false;
  }
  const active = items[activeIndex];
  if (active.kind === 'sequence') {
    const resolved = resolveProgramSongLeaf(sequence);
    if (resolved) {
      const result = advanceSequenceCursor(sequence, resolved.id);
      if (result !== 'not-found') return result === 'advanced';
    }
  }

  const next = items[activeIndex + 1] ?? null;
  if (next) {
    sequence.activeItemId = next.id;
    sequence.startedAt = Date.now();
    if (next.kind === 'sequence') resetSequenceCursor(next.sequence);
    return true;
  }
  if (sequence.loop !== false && sequence.items.length > 0) {
    resetSequenceCursor(sequence);
    sequence.startedAt = Date.now();
    return true;
  }
  sequence.activeItemId = null;
  return false;
}

function normalizeSongLeafItem(
  record: RecordValue,
): ProgramSongSequenceLeafItem {
  const artist =
    typeof record.artist === 'string' && record.artist.trim()
      ? record.artist.trim()
      : '';
  const title =
    typeof record.title === 'string' && record.title.trim()
      ? record.title.trim()
      : '';
  const coverUrl =
    typeof record.coverUrl === 'string' && record.coverUrl.trim()
      ? record.coverUrl.trim()
      : '';
  const audioUrl =
    typeof record.audioUrl === 'string' && record.audioUrl.trim()
      ? record.audioUrl.trim()
      : '';
  const durationMs =
    typeof record.durationMs === 'number' &&
    Number.isFinite(record.durationMs) &&
    record.durationMs > 0
      ? Math.round(record.durationMs)
      : undefined;

  return {
    id:
      typeof record.id === 'string' && record.id
        ? record.id
        : `song_${Date.now().toString(36)}`,
    kind: 'preset',
    songId:
      typeof record.songId === 'number' &&
      Number.isInteger(record.songId) &&
      record.songId > 0
        ? record.songId
        : undefined,
    highRotation: record.highRotation === true,
    artist,
    title,
    coverUrl,
    audioUrl: audioUrl || undefined,
    durationMs,
    earoneSongId:
      typeof record.earoneSongId === 'string' && record.earoneSongId.trim()
        ? record.earoneSongId.trim()
        : typeof record.earoneSongId === 'number' &&
            Number.isFinite(record.earoneSongId)
          ? String(record.earoneSongId)
          : undefined,
    earoneRank:
      typeof record.earoneRank === 'string' && record.earoneRank.trim()
        ? record.earoneRank.trim()
        : undefined,
    earoneSpins:
      typeof record.earoneSpins === 'string' && record.earoneSpins.trim()
        ? record.earoneSpins.trim()
        : typeof record.earoneSpins === 'number' &&
            Number.isFinite(record.earoneSpins)
          ? String(record.earoneSpins)
          : undefined,
  };
}

function withNormalizedSequenceShape<TItem extends BaseSequenceItem>(
  record: RecordValue,
  items: TItem[],
): BaseSequence<TItem> {
  const activeItemId =
    record.activeItemId === null
      ? null
      : typeof record.activeItemId === 'string' &&
          items.some((item) => item.id === record.activeItemId)
        ? record.activeItemId
        : (items[0]?.id ?? null);

  return {
    mode: normalizeMode(record.mode),
    items,
    activeItemId,
    intervalMs:
      typeof record.intervalMs === 'number' &&
      Number.isFinite(record.intervalMs) &&
      record.intervalMs >= 500
        ? Math.floor(record.intervalMs)
        : 4000,
    loop: record.loop === undefined ? true : Boolean(record.loop),
    startedAt:
      typeof record.startedAt === 'number' && Number.isFinite(record.startedAt)
        ? record.startedAt
        : Date.now(),
    ...(Array.isArray(record.shuffleOrder)
      ? {
          shuffleOrder: record.shuffleOrder.filter(
            (id): id is string => typeof id === 'string',
          ),
        }
      : {}),
  };
}

function normalizeSongSequenceItem(
  value: unknown,
  depth: number,
): ProgramSongSequenceItem | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  if (record.kind === 'sequence') {
    const normalizedSequence = normalizeProgramSongSequence(
      record.sequence,
      depth + 1,
    );
    if (!normalizedSequence) {
      return null;
    }

    return {
      id:
        typeof record.id === 'string' && record.id
          ? record.id
          : `sequence_${Date.now().toString(36)}`,
      label:
        typeof record.label === 'string' && record.label.trim()
          ? record.label
          : 'Nested Sequence',
      kind: 'sequence',
      sequence: normalizedSequence,
    };
  }

  return normalizeSongLeafItem(record);
}

export function normalizeProgramSongSequence(
  value: unknown,
  depth = 0,
): ProgramSongSequence | null {
  if (depth > MAX_DEPTH) {
    return null;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const rawItems = Array.isArray(record.items) ? record.items : [];
  const items = rawItems
    .map((item) => normalizeSongSequenceItem(item, depth))
    .filter((item): item is ProgramSongSequenceItem => item !== null);

  const sequence: ProgramSongSequence = withNormalizedSequenceShape(
    record,
    items,
  );
  if (
    typeof record.endedAt === 'number' &&
    Number.isFinite(record.endedAt) &&
    record.endedAt > 0
  )
    sequence.endedAt = record.endedAt;
  return sequence;
}

function getBaseIndex<TItem extends BaseSequenceItem>(
  sequence: BaseSequence<TItem>,
): number | null {
  if (sequence.activeItemId === null) {
    return null;
  }

  const activeIndex = sequence.items.findIndex(
    (item) => item.id === sequence.activeItemId,
  );
  return activeIndex >= 0 ? activeIndex : 0;
}

function getSongItemPlaybackDurationMs(
  item: ProgramSongSequenceItem,
): number | null {
  if (
    item.kind === 'preset' &&
    typeof item.durationMs === 'number' &&
    Number.isFinite(item.durationMs) &&
    item.durationMs > 0
  ) {
    return Math.max(1, Math.round(item.durationMs));
  }

  return null;
}

function getSelectedSongItem(
  stored: ProgramSongSequence,
  nowMs: number,
): ProgramSongSequenceItem | null {
  // Every walk below is along the order that plays.
  const sequence = { ...stored, items: programSongPlayOrder(stored) };
  if (sequence.items.length === 0) {
    return null;
  }

  const baseIndex = getBaseIndex(sequence);
  if (baseIndex === null) {
    return null;
  }

  if (sequence.mode === 'manual') {
    return sequence.items[baseIndex];
  }

  const startedAt = sequence.startedAt ?? nowMs;
  const elapsedMs = Math.max(0, nowMs - startedAt);
  const itemDurations = sequence.items.map((item) =>
    getSongItemPlaybackDurationMs(item),
  );

  if (sequence.loop !== false) {
    const hasUnknownDuration = itemDurations.some(
      (durationMs) => durationMs === null,
    );
    if (!hasUnknownDuration) {
      // Every duration is a known integer of at least one millisecond, so the
      // cycle is positive and the remainder lands inside exactly one item. A
      // non-finite clock yields a NaN remainder, which keeps the active item.
      const knownDurations = itemDurations as number[];
      const cycleDurationMs = knownDurations.reduce(
        (sum, durationMs) => sum + durationMs,
        0,
      );

      let remainingMs = elapsedMs % cycleDurationMs;
      for (let step = 0; step < sequence.items.length; step += 1) {
        const index = (baseIndex + step) % sequence.items.length;
        const itemDurationMs = knownDurations[index];
        if (remainingMs < itemDurationMs) {
          return sequence.items[index];
        }
        remainingMs -= itemDurationMs;
      }

      return sequence.items[baseIndex];
    }

    // At least one duration is unknown, so the walk always stops at the first
    // unknown item at the latest.
    let remainingMs = elapsedMs;
    const stopIndex = itemDurations
      .map((_, step) => (baseIndex + step) % sequence.items.length)
      .find((index) => {
        const itemDurationMs = itemDurations[index];
        if (
          typeof itemDurationMs !== 'number' ||
          remainingMs < itemDurationMs
        ) {
          return true;
        }
        remainingMs -= itemDurationMs;
        return false;
      }) as number;
    return sequence.items[stopIndex];
  }

  let index = baseIndex;
  let remainingMs = elapsedMs;
  while (index < sequence.items.length - 1) {
    const itemDurationMs = itemDurations[index];
    if (typeof itemDurationMs !== 'number') {
      return sequence.items[index];
    }
    if (remainingMs < itemDurationMs) {
      break;
    }
    remainingMs -= itemDurationMs;
    index += 1;
  }

  return sequence.items[index];
}

function resolveSongSequenceRecursive(
  sequence: ProgramSongSequence,
  nowMs: number,
  depth: number,
  labels: string[],
): ProgramResolvedSongLeaf | null {
  if (depth > MAX_DEPTH) {
    return null;
  }

  const selected = getSelectedSongItem(sequence, nowMs);
  if (!selected) {
    return null;
  }

  if (selected.kind === 'sequence') {
    const nextLabels = [...labels, selected.label];
    return resolveSongSequenceRecursive(
      selected.sequence,
      nowMs,
      depth + 1,
      nextLabels,
    );
  }

  const songLabel = [selected.artist, selected.title]
    .filter(Boolean)
    .join(' - ');
  return {
    id: selected.id,
    songId: selected.songId,
    highRotation: selected.highRotation === true,
    artist: selected.artist,
    title: selected.title,
    coverUrl: selected.coverUrl,
    audioUrl: selected.audioUrl,
    durationMs: selected.durationMs,
    earoneSongId: selected.earoneSongId,
    earoneRank: selected.earoneRank,
    earoneSpins: selected.earoneSpins,
    activePathLabels: [...labels, songLabel || 'Song Preset'],
  };
}

function collectProgramSongLeavesRecursive(
  sequence: ProgramSongSequence,
  labels: string[],
  leaves: ProgramResolvedSongLeaf[],
  depth: number,
): void {
  if (depth > MAX_DEPTH) return;
  for (const item of sequence.items) {
    if (item.kind === 'sequence') {
      collectProgramSongLeavesRecursive(
        item.sequence,
        [...labels, item.label],
        leaves,
        depth + 1,
      );
      continue;
    }
    const songLabel = [item.artist, item.title].filter(Boolean).join(' - ');
    leaves.push({
      ...item,
      highRotation: item.highRotation === true,
      activePathLabels: [...labels, songLabel || 'Song Preset'],
    });
  }
}

export function collectProgramSongLeaves(
  sequence: ProgramSongSequence | null,
): ProgramResolvedSongLeaf[] {
  if (!sequence) return [];
  const leaves: ProgramResolvedSongLeaf[] = [];
  collectProgramSongLeavesRecursive(sequence, [], leaves, 0);
  return leaves;
}

/**
 * How many leaves each song has in a sequence, keyed by the song id (else by the audio
 * address), with a label for messages. A song airs once per leaf in a rotation, so a
 * second leaf for the same song doubles its share (gaulatti/alcantara#280).
 */
export function countProgramSongLeavesBySong(
  sequence: ProgramSongSequence | null,
): Map<string, { count: number; label: string }> {
  const counts = new Map<string, { count: number; label: string }>();
  for (const leaf of collectProgramSongLeaves(sequence)) {
    const key =
      typeof leaf.songId === 'number'
        ? `song:${leaf.songId}`
        : leaf.audioUrl?.trim()
          ? `url:${leaf.audioUrl.trim()}`
          : null;
    if (!key) continue;
    const seen = counts.get(key);
    if (seen) seen.count += 1;
    else
      counts.set(key, {
        count: 1,
        label: [leaf.artist, leaf.title].filter(Boolean).join(' - ') || key,
      });
  }
  return counts;
}

export function collectHighRotationProgramSongLeaves(
  sequence: ProgramSongSequence | null,
): ProgramResolvedSongLeaf[] {
  return collectProgramSongLeaves(sequence).filter((song) => song.highRotation);
}

export function activateProgramSongLeaf(
  sequence: ProgramSongSequence,
  itemId: string,
  depth = 0,
): boolean {
  if (depth > MAX_DEPTH) return false;
  for (const item of sequence.items) {
    if (item.kind === 'preset') {
      if (item.id !== itemId) continue;
      sequence.activeItemId = item.id;
      sequence.startedAt = Date.now();
      return true;
    }
    if (!activateProgramSongLeaf(item.sequence, itemId, depth + 1)) continue;
    sequence.activeItemId = item.id;
    sequence.startedAt = Date.now();
    return true;
  }
  return false;
}

export function resolveProgramSongLeaf(
  sequence: ProgramSongSequence | null,
  nowMs: number = Date.now(),
): ProgramResolvedSongLeaf | null {
  if (!sequence) {
    return null;
  }

  return resolveSongSequenceRecursive(sequence, nowMs, 0, []);
}

function collectSongLeavesByAudioUrl(
  sequence: ProgramSongSequence,
  audioUrl: string,
  labels: string[],
  matches: ProgramResolvedSongLeaf[],
  depth: number,
): void {
  if (depth > MAX_DEPTH || matches.length > 1) return;

  for (const item of sequence.items) {
    if (item.kind === 'sequence') {
      collectSongLeavesByAudioUrl(
        item.sequence,
        audioUrl,
        [...labels, item.label],
        matches,
        depth + 1,
      );
      continue;
    }
    if (item.audioUrl !== audioUrl) continue;
    const songLabel = [item.artist, item.title].filter(Boolean).join(' - ');
    matches.push({
      ...item,
      highRotation: item.highRotation === true,
      activePathLabels: [...labels, songLabel || 'Song Preset'],
    });
  }
}

function collectSongLeavesById(
  sequence: ProgramSongSequence,
  itemId: string,
  labels: string[],
  matches: ProgramResolvedSongLeaf[],
  depth: number,
): void {
  if (depth > MAX_DEPTH || matches.length > 1) return;

  for (const item of sequence.items) {
    if (item.kind === 'sequence') {
      collectSongLeavesById(
        item.sequence,
        itemId,
        [...labels, item.label],
        matches,
        depth + 1,
      );
      continue;
    }
    if (item.id !== itemId) continue;
    const songLabel = [item.artist, item.title].filter(Boolean).join(' - ');
    matches.push({
      ...item,
      highRotation: item.highRotation === true,
      activePathLabels: [...labels, songLabel || 'Song Preset'],
    });
  }
}

/** Returns a leaf only when its playlist item ID is unique. */
export function findUniqueProgramSongLeafById(
  sequence: ProgramSongSequence | null,
  itemId: string,
): ProgramResolvedSongLeaf | null {
  const normalizedItemId = itemId.trim();
  if (!sequence || !normalizedItemId) return null;
  const matches: ProgramResolvedSongLeaf[] = [];
  collectSongLeavesById(sequence, normalizedItemId, [], matches, 0);
  return matches.length === 1 ? matches[0] : null;
}

/** Returns a leaf only when an authoritative URL identifies exactly one song. */
export function findUniqueProgramSongLeafByAudioUrl(
  sequence: ProgramSongSequence | null,
  audioUrl: string,
): ProgramResolvedSongLeaf | null {
  const normalizedUrl = audioUrl.trim();
  if (!sequence || !normalizedUrl) return null;
  const matches: ProgramResolvedSongLeaf[] = [];
  collectSongLeavesByAudioUrl(sequence, normalizedUrl, [], matches, 0);
  return matches.length === 1 ? matches[0] : null;
}

/** How many leaves carry this audio URL: 0, 1, or 2 for two or more. */
export function countProgramSongLeavesByAudioUrl(
  sequence: ProgramSongSequence | null,
  audioUrl: string,
): 0 | 1 | 2 {
  const normalizedUrl = audioUrl.trim();
  if (!sequence || !normalizedUrl) return 0;
  const matches: ProgramResolvedSongLeaf[] = [];
  collectSongLeavesByAudioUrl(sequence, normalizedUrl, [], matches, 0);
  return Math.min(matches.length, 2) as 0 | 1 | 2;
}

/**
 * The sequence as an operator edits it: every field except the cursor
 * (`activeItemId`, `startedAt`, at every level). Two sequences with the same
 * structure differ only by where the rotation is.
 */
export function programSongSequenceStructure(
  sequence: ProgramSongSequence | null,
): string {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(
            ([key]) =>
              key !== 'activeItemId' &&
              key !== 'startedAt' &&
              // Where the rotation stands, not an edit: the engine sets it when the rotation runs out.
              key !== 'endedAt',
          )
          .map(([key, inner]) => [key, strip(inner)]),
      );
    return value;
  };
  return JSON.stringify(strip(sequence));
}

export function getProgramSongSequenceSelectedItemId(
  sequence: ProgramSongSequence,
  nowMs: number = Date.now(),
): string | null {
  return getSelectedSongItem(sequence, nowMs)?.id ?? null;
}

/** The id of the leaf the cursor points at, following the cursor down through nested blocks. */
export function activeProgramSongLeafId(
  sequence: ProgramSongSequence | null,
): string | null {
  let current: ProgramSongSequence | null = sequence;
  for (let depth = 0; current && depth <= MAX_DEPTH; depth += 1) {
    const item: ProgramSongSequenceItem | undefined = current.items.find(
      (candidate) => candidate.id === current!.activeItemId,
    );
    if (!item) return null;
    if (item.kind === 'preset') return item.id;
    current = item.sequence;
  }
  return null;
}

/**
 * Removes the leaves with these ids (nested blocks included) from the sequence in place and
 * returns them. Nothing else changes, except a cursor that pointed at a removed item, which
 * moves to the first remaining item of its block (gaulatti/alcantara#327).
 */
export function removeProgramSongLeavesInPlace(
  sequence: ProgramSongSequence,
  leafIds: ReadonlySet<string>,
  depth = 0,
): ProgramSongSequenceLeafItem[] {
  if (depth > MAX_DEPTH) return [];
  const removed: ProgramSongSequenceLeafItem[] = [];
  const kept: ProgramSongSequenceItem[] = [];
  for (const item of sequence.items) {
    if (item.kind === 'preset' && leafIds.has(item.id)) {
      removed.push(item);
      continue;
    }
    if (item.kind === 'sequence')
      removed.push(
        ...removeProgramSongLeavesInPlace(item.sequence, leafIds, depth + 1),
      );
    kept.push(item);
  }
  sequence.items = kept;
  if (
    sequence.activeItemId !== null &&
    !kept.some((item) => item.id === sequence.activeItemId)
  )
    resetSequenceCursor(sequence);
  return removed;
}
