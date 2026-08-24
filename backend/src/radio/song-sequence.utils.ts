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
}

export interface ProgramSongSequenceLeafItem extends BaseSequenceItem {
  kind: 'preset';
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

export type ProgramSongSequence = BaseSequence<ProgramSongSequenceItem>;

export interface ProgramResolvedSongLeaf {
  id: string;
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

type SequenceAdvanceResult = 'advanced' | 'exhausted' | 'not-found';

function resetSequenceCursor(sequence: ProgramSongSequence): void {
  const first = sequence.items[0] ?? null;
  sequence.activeItemId = first?.id ?? null;
  if (first?.kind === 'sequence') resetSequenceCursor(first.sequence);
}

function advanceSequenceCursor(
  sequence: ProgramSongSequence,
  activeLeafId: string,
): SequenceAdvanceResult {
  for (let index = 0; index < sequence.items.length; index += 1) {
    const item = sequence.items[index];
    let found = item.kind === 'preset' && item.id === activeLeafId;

    if (item.kind === 'sequence') {
      const nestedResult = advanceSequenceCursor(item.sequence, activeLeafId);
      if (nestedResult === 'advanced') return 'advanced';
      found = nestedResult === 'exhausted';
    }

    if (!found) continue;

    const next = sequence.items[index + 1] ?? null;
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

  const activeIndex = sequence.items.findIndex(
    (item) => item.id === sequence.activeItemId,
  );
  if (activeIndex < 0) return false;
  const active = sequence.items[activeIndex];
  if (active.kind === 'sequence') {
    const resolved = resolveProgramSongLeaf(sequence);
    if (resolved) {
      const result = advanceSequenceCursor(sequence, resolved.id);
      if (result !== 'not-found') return result === 'advanced';
    }
  }

  const next = sequence.items[activeIndex + 1] ?? null;
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

  return withNormalizedSequenceShape(record, items);
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
  sequence: ProgramSongSequence,
  nowMs: number,
): ProgramSongSequenceItem | null {
  if (sequence.items.length === 0) {
    return null;
  }

  const baseIndex = getBaseIndex(sequence);
  if (baseIndex === null) {
    return null;
  }

  if (sequence.mode === 'manual') {
    return sequence.items[baseIndex] ?? null;
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
      const knownDurations = itemDurations as number[];
      const cycleDurationMs = knownDurations.reduce(
        (sum, durationMs) => sum + durationMs,
        0,
      );
      if (cycleDurationMs <= 0) {
        return sequence.items[baseIndex] ?? null;
      }

      let remainingMs = elapsedMs % cycleDurationMs;
      for (let step = 0; step < sequence.items.length; step += 1) {
        const index = (baseIndex + step) % sequence.items.length;
        const itemDurationMs = knownDurations[index];
        if (typeof itemDurationMs !== 'number') {
          return sequence.items[index] ?? null;
        }
        if (remainingMs < itemDurationMs) {
          return sequence.items[index] ?? null;
        }
        remainingMs -= itemDurationMs;
      }

      return sequence.items[baseIndex] ?? null;
    }

    let remainingMs = elapsedMs;
    for (let step = 0; step < sequence.items.length; step += 1) {
      const index = (baseIndex + step) % sequence.items.length;
      const itemDurationMs = itemDurations[index];
      if (typeof itemDurationMs !== 'number') {
        return sequence.items[index] ?? null;
      }
      if (remainingMs < itemDurationMs) {
        return sequence.items[index] ?? null;
      }
      remainingMs -= itemDurationMs;
    }

    return sequence.items[baseIndex] ?? null;
  }

  let index = baseIndex;
  let remainingMs = elapsedMs;
  while (index < sequence.items.length - 1) {
    const itemDurationMs = itemDurations[index];
    if (typeof itemDurationMs !== 'number') {
      return sequence.items[index] ?? null;
    }
    if (remainingMs < itemDurationMs) {
      break;
    }
    remainingMs -= itemDurationMs;
    index += 1;
  }

  return sequence.items[index] ?? null;
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

export function resolveProgramSongLeaf(
  sequence: ProgramSongSequence | null,
  nowMs: number = Date.now(),
): ProgramResolvedSongLeaf | null {
  if (!sequence) {
    return null;
  }

  return resolveSongSequenceRecursive(sequence, nowMs, 0, []);
}

export function getProgramSongSequenceSelectedItemId(
  sequence: ProgramSongSequence,
  nowMs: number = Date.now(),
): string | null {
  return getSelectedSongItem(sequence, nowMs)?.id ?? null;
}
