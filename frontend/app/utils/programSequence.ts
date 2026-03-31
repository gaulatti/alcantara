export type ProgramSequenceMode = 'manual' | 'autoplay';
export type ProgramTextContentMode = 'text' | 'sequence';
export type ProgramSongContentMode = 'sequence';

interface BaseSequenceItem {
  id: string;
}

interface BaseSequence<TItem extends BaseSequenceItem> {
  mode: ProgramSequenceMode;
  items: TItem[];
  activeItemId?: string | null;
  intervalMs?: number;
  loop?: boolean;
  startedAt?: number;
}

type RecordValue = Record<string, unknown>;
const MAX_DEPTH = 8;

export interface ProgramTextSequenceLeafItem extends BaseSequenceItem {
  kind: 'preset';
  text: string;
  useMarquee?: boolean;
}

export interface ProgramTextSequenceNestedItem extends BaseSequenceItem {
  label: string;
  kind: 'sequence';
  sequence: ProgramTextSequence;
}

export type ProgramTextSequenceItem =
  | ProgramTextSequenceLeafItem
  | ProgramTextSequenceNestedItem;

export type ProgramTextSequence = BaseSequence<ProgramTextSequenceItem>;

export interface ProgramResolvedTextContent {
  text: string;
  useMarquee: boolean;
  source: ProgramTextContentMode;
  activePathLabels: string[];
}

export interface ProgramResolvedTextLeaf {
  text: string;
  useMarquee: boolean;
  activePathLabels: string[];
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

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeMode(value: unknown): ProgramSequenceMode {
  return value === 'autoplay' ? 'autoplay' : 'manual';
}

function normalizeTextContentMode(
  contentMode: unknown,
  sequence: ProgramTextSequence | null
): ProgramTextContentMode {
  if (contentMode === 'text') {
    return 'text';
  }
  if (contentMode === 'sequence') {
    return 'sequence';
  }
  return sequence ? 'sequence' : 'text';
}

function normalizeSongContentMode(
  contentMode: unknown,
  sequence: ProgramSongSequence | null
): ProgramSongContentMode {
  return 'sequence';
}

function normalizeTextLeafItem(
  record: RecordValue,
  options?: { includeMarquee?: boolean }
): ProgramTextSequenceLeafItem {
  const text =
    typeof record.text === 'string' && record.text.trim()
      ? record.text
      : typeof record.label === 'string'
        ? record.label
        : '';

  return {
    id: typeof record.id === 'string' && record.id ? record.id : createId('preset'),
    kind: 'preset',
    text,
    useMarquee: options?.includeMarquee ? Boolean(record.useMarquee) : undefined
  };
}

function normalizeSongLeafItem(record: RecordValue): ProgramSongSequenceLeafItem {
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
    id: typeof record.id === 'string' && record.id ? record.id : createId('song'),
    kind: 'preset',
    artist,
    title,
    coverUrl,
    audioUrl: audioUrl || undefined,
    durationMs,
    earoneSongId:
      typeof record.earoneSongId === 'string' && record.earoneSongId.trim()
        ? record.earoneSongId.trim()
        : typeof record.earoneSongId === 'number' && Number.isFinite(record.earoneSongId)
          ? String(record.earoneSongId)
          : undefined,
    earoneRank:
      typeof record.earoneRank === 'string' && record.earoneRank.trim()
        ? record.earoneRank.trim()
        : undefined,
    earoneSpins:
      typeof record.earoneSpins === 'string' && record.earoneSpins.trim()
        ? record.earoneSpins.trim()
        : typeof record.earoneSpins === 'number' && Number.isFinite(record.earoneSpins)
          ? String(record.earoneSpins)
          : undefined
  };
}

function withNormalizedSequenceShape<TItem extends BaseSequenceItem>(
  record: RecordValue,
  items: TItem[]
): BaseSequence<TItem> {
  const activeItemId =
    record.activeItemId === null
      ? null
      : typeof record.activeItemId === 'string' && items.some((item) => item.id === record.activeItemId)
      ? record.activeItemId
      : items[0]?.id ?? null;

  return {
    mode: normalizeMode(record.mode),
    items,
    activeItemId,
    intervalMs:
      typeof record.intervalMs === 'number' && Number.isFinite(record.intervalMs) && record.intervalMs >= 500
        ? Math.floor(record.intervalMs)
        : 4000,
    loop: record.loop === undefined ? true : Boolean(record.loop),
    startedAt:
      typeof record.startedAt === 'number' && Number.isFinite(record.startedAt)
        ? record.startedAt
        : Date.now()
  };
}

function normalizeTextSequenceItem(
  value: unknown,
  depth: number,
  options?: { includeMarquee?: boolean }
): ProgramTextSequenceItem | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  if (record.kind === 'sequence') {
    const normalizedSequence = normalizeProgramTextSequence(record.sequence, depth + 1, options);
    if (!normalizedSequence) {
      return null;
    }

    return {
      id: typeof record.id === 'string' && record.id ? record.id : createId('sequence'),
      label: typeof record.label === 'string' && record.label.trim() ? record.label : 'Nested Sequence',
      kind: 'sequence',
      sequence: normalizedSequence
    };
  }

  return normalizeTextLeafItem(record, options);
}

function normalizeSongSequenceItem(
  value: unknown,
  depth: number
): ProgramSongSequenceItem | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  if (record.kind === 'sequence') {
    const normalizedSequence = normalizeProgramSongSequence(record.sequence, depth + 1);
    if (!normalizedSequence) {
      return null;
    }

    return {
      id: typeof record.id === 'string' && record.id ? record.id : createId('sequence'),
      label: typeof record.label === 'string' && record.label.trim() ? record.label : 'Nested Sequence',
      kind: 'sequence',
      sequence: normalizedSequence
    };
  }

  return normalizeSongLeafItem(record);
}

function getBaseIndex<TItem extends BaseSequenceItem>(
  sequence: BaseSequence<TItem>
): number | null {
  if (sequence.activeItemId === null) {
    return null;
  }

  const activeIndex = sequence.items.findIndex((item) => item.id === sequence.activeItemId);
  return activeIndex >= 0 ? activeIndex : 0;
}

function getSelectedItem<TItem extends BaseSequenceItem>(
  sequence: BaseSequence<TItem>,
  nowMs: number
): TItem | null {
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
  const intervalMs = Math.max(500, sequence.intervalMs ?? 4000);
  const elapsedSteps = Math.max(0, Math.floor((nowMs - startedAt) / intervalMs));
  let nextIndex = baseIndex + elapsedSteps;

  if (sequence.loop !== false) {
    nextIndex %= sequence.items.length;
  } else if (nextIndex >= sequence.items.length) {
    nextIndex = sequence.items.length - 1;
  }

  return sequence.items[nextIndex] ?? null;
}

function getSongItemPlaybackDurationMs(
  item: ProgramSongSequenceItem
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
  nowMs: number
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
  const itemDurations = sequence.items.map((item) => getSongItemPlaybackDurationMs(item));

  if (sequence.loop !== false) {
    const hasUnknownDuration = itemDurations.some((durationMs) => durationMs === null);
    if (!hasUnknownDuration) {
      const cycleDurationMs = itemDurations.reduce((sum, durationMs) => sum + (durationMs ?? 0), 0);
      if (cycleDurationMs <= 0) {
        return sequence.items[baseIndex] ?? null;
      }

      let remainingMs = elapsedMs % cycleDurationMs;
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

function resolveTextSequenceRecursive(
  sequence: ProgramTextSequence,
  nowMs: number,
  depth: number,
  labels: string[]
): ProgramResolvedTextLeaf | null {
  if (depth > MAX_DEPTH) {
    return null;
  }

  const selected = getSelectedItem(sequence, nowMs);
  if (!selected) {
    return null;
  }

  if (selected.kind === 'sequence') {
    const nextLabels = [...labels, selected.label];
    return resolveTextSequenceRecursive(selected.sequence, nowMs, depth + 1, nextLabels);
  }

  return {
    text: selected.text,
    useMarquee: Boolean(selected.useMarquee),
    activePathLabels: [...labels, selected.text]
  };
}

function resolveSongSequenceRecursive(
  sequence: ProgramSongSequence,
  nowMs: number,
  depth: number,
  labels: string[]
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
    return resolveSongSequenceRecursive(selected.sequence, nowMs, depth + 1, nextLabels);
  }

  const songLabel = [selected.artist, selected.title].filter(Boolean).join(' - ');
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
    activePathLabels: [...labels, songLabel || 'Song Preset']
  };
}

export function normalizeProgramTextSequence(
  value: unknown,
  depth = 0,
  options?: { includeMarquee?: boolean }
): ProgramTextSequence | null {
  if (depth > MAX_DEPTH) {
    return null;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const rawItems = Array.isArray(record.items) ? record.items : [];
  const items = rawItems
    .map((item) => normalizeTextSequenceItem(item, depth, options))
    .filter((item): item is ProgramTextSequenceItem => item !== null);

  return withNormalizedSequenceShape(record, items);
}

export function normalizeProgramSongSequence(
  value: unknown,
  depth = 0
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

export function createProgramTextSequenceItem(
  kind: ProgramTextSequenceItem['kind'] = 'preset',
  options?: { includeMarquee?: boolean }
): ProgramTextSequenceItem {
  if (kind === 'sequence') {
    return {
      id: createId('sequence'),
      label: 'Nested Sequence',
      kind: 'sequence',
      sequence: createProgramTextSequence('manual', options)
    };
  }

  return {
    id: createId('preset'),
    kind: 'preset',
    text: '',
    useMarquee: options?.includeMarquee ? false : undefined
  };
}

export function createProgramSongSequenceItem(
  kind: ProgramSongSequenceItem['kind'] = 'preset'
): ProgramSongSequenceItem {
  if (kind === 'sequence') {
    return {
      id: createId('sequence'),
      label: 'Nested Sequence',
      kind: 'sequence',
      sequence: createProgramSongSequence('manual')
    };
  }

  return {
    id: createId('song'),
    kind: 'preset',
    artist: '',
    title: '',
    coverUrl: '',
    audioUrl: '',
    durationMs: undefined
  };
}

export function createProgramTextSequence(
  mode: ProgramSequenceMode = 'manual',
  options?: { includeMarquee?: boolean }
): ProgramTextSequence {
  const firstItem = createProgramTextSequenceItem('preset', options);

  return {
    mode,
    items: [firstItem],
    activeItemId: firstItem.id,
    intervalMs: 4000,
    loop: true,
    startedAt: Date.now()
  };
}

export function createProgramSongSequence(
  mode: ProgramSequenceMode = 'manual'
): ProgramSongSequence {
  return {
    mode,
    items: [],
    activeItemId: null,
    intervalMs: 4000,
    loop: true,
    startedAt: Date.now()
  };
}

export function getProgramTextContentMode(
  contentMode: unknown,
  sequence: ProgramTextSequence | null
): ProgramTextContentMode {
  return normalizeTextContentMode(contentMode, sequence);
}

export function getProgramSongContentMode(
  contentMode: unknown,
  sequence: ProgramSongSequence | null
): ProgramSongContentMode {
  return normalizeSongContentMode(contentMode, sequence);
}

export function getProgramTextSequenceSelectedItemId(
  sequence: ProgramTextSequence,
  nowMs = Date.now()
): string | null {
  return getSelectedItem(sequence, nowMs)?.id ?? null;
}

export function getProgramSongSequenceSelectedItemId(
  sequence: ProgramSongSequence,
  nowMs = Date.now()
): string | null {
  return getSelectedSongItem(sequence, nowMs)?.id ?? null;
}

export function resolveProgramTextContent(
  config: {
    text?: string;
    useMarquee?: boolean;
    contentMode?: unknown;
    sequence?: unknown;
  },
  nowMs = Date.now(),
  options?: { includeMarquee?: boolean }
): ProgramResolvedTextContent {
  const normalizedSequence = normalizeProgramTextSequence(config.sequence, 0, options);
  const contentMode = normalizeTextContentMode(config.contentMode, normalizedSequence);

  if (contentMode === 'sequence' && normalizedSequence) {
    const resolved = resolveTextSequenceRecursive(normalizedSequence, nowMs, 0, []);
    if (resolved) {
      return {
        text: resolved.text,
        useMarquee: resolved.useMarquee,
        source: 'sequence',
        activePathLabels: resolved.activePathLabels
      };
    }
  }

  return {
    text: typeof config.text === 'string' ? config.text : '',
    useMarquee: Boolean(config.useMarquee),
    source: 'text',
    activePathLabels: []
  };
}

export function resolveProgramTextLeaf(
  config: {
    contentMode?: unknown;
    sequence?: unknown;
  },
  nowMs = Date.now(),
  options?: { includeMarquee?: boolean }
): ProgramResolvedTextLeaf | null {
  const normalizedSequence = normalizeProgramTextSequence(config.sequence, 0, options);
  const contentMode = normalizeTextContentMode(config.contentMode, normalizedSequence);

  if (contentMode !== 'sequence' || !normalizedSequence) {
    return null;
  }

  return resolveTextSequenceRecursive(normalizedSequence, nowMs, 0, []);
}

export function resolveProgramSongLeaf(
  config: {
    contentMode?: unknown;
    sequence?: unknown;
  },
  nowMs = Date.now()
): ProgramResolvedSongLeaf | null {
  const normalizedSequence = normalizeProgramSongSequence(config.sequence);
  const contentMode = normalizeSongContentMode(config.contentMode, normalizedSequence);

  if (contentMode !== 'sequence' || !normalizedSequence) {
    return null;
  }

  return resolveSongSequenceRecursive(normalizedSequence, nowMs, 0, []);
}

export function countProgramTextSequenceLeafItems(
  sequence: ProgramTextSequence | null
): number {
  if (!sequence) {
    return 0;
  }

  return sequence.items.reduce((count, item) => {
    if (item.kind === 'sequence') {
      return count + countProgramTextSequenceLeafItems(item.sequence);
    }
    return count + 1;
  }, 0);
}

export function countProgramSongSequenceLeafItems(
  sequence: ProgramSongSequence | null
): number {
  if (!sequence) {
    return 0;
  }

  return sequence.items.reduce((count, item) => {
    if (item.kind === 'sequence') {
      return count + countProgramSongSequenceLeafItems(item.sequence);
    }
    return count + 1;
  }, 0);
}
