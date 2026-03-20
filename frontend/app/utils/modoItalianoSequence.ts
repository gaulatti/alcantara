export type ModoItalianoSequenceMode = 'manual' | 'autoplay';
export type ModoItalianoTextContentMode = 'text' | 'sequence';
export type ModoItalianoSongContentMode = 'direct' | 'sequence';

interface BaseSequenceItem {
  id: string;
}

interface BaseSequence<TItem extends BaseSequenceItem> {
  mode: ModoItalianoSequenceMode;
  items: TItem[];
  activeItemId?: string | null;
  intervalMs?: number;
  loop?: boolean;
  startedAt?: number;
}

type RecordValue = Record<string, unknown>;
const MAX_DEPTH = 8;

export interface ModoItalianoTextSequenceLeafItem extends BaseSequenceItem {
  kind: 'preset';
  text: string;
  useMarquee?: boolean;
}

export interface ModoItalianoTextSequenceNestedItem extends BaseSequenceItem {
  label: string;
  kind: 'sequence';
  sequence: ModoItalianoTextSequence;
}

export type ModoItalianoTextSequenceItem =
  | ModoItalianoTextSequenceLeafItem
  | ModoItalianoTextSequenceNestedItem;

export type ModoItalianoTextSequence = BaseSequence<ModoItalianoTextSequenceItem>;

export interface ModoItalianoResolvedTextContent {
  text: string;
  useMarquee: boolean;
  source: ModoItalianoTextContentMode;
  activePathLabels: string[];
}

export interface ModoItalianoResolvedTextLeaf {
  text: string;
  useMarquee: boolean;
  activePathLabels: string[];
}

export interface ModoItalianoSongSequenceLeafItem extends BaseSequenceItem {
  kind: 'preset';
  artist: string;
  title: string;
  coverUrl: string;
  earoneSongId?: string;
  earoneRank?: string;
  earoneSpins?: string;
}

export interface ModoItalianoSongSequenceNestedItem extends BaseSequenceItem {
  label: string;
  kind: 'sequence';
  sequence: ModoItalianoSongSequence;
}

export type ModoItalianoSongSequenceItem =
  | ModoItalianoSongSequenceLeafItem
  | ModoItalianoSongSequenceNestedItem;

export type ModoItalianoSongSequence = BaseSequence<ModoItalianoSongSequenceItem>;

export interface ModoItalianoResolvedSongLeaf {
  artist: string;
  title: string;
  coverUrl: string;
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

function normalizeMode(value: unknown): ModoItalianoSequenceMode {
  return value === 'autoplay' ? 'autoplay' : 'manual';
}

function normalizeTextContentMode(
  contentMode: unknown,
  sequence: ModoItalianoTextSequence | null
): ModoItalianoTextContentMode {
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
  sequence: ModoItalianoSongSequence | null
): ModoItalianoSongContentMode {
  if (contentMode === 'direct') {
    return 'direct';
  }
  if (contentMode === 'sequence') {
    return 'sequence';
  }
  return sequence ? 'sequence' : 'direct';
}

function normalizeTextLeafItem(
  record: RecordValue,
  options?: { includeMarquee?: boolean }
): ModoItalianoTextSequenceLeafItem {
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

function normalizeSongLeafItem(record: RecordValue): ModoItalianoSongSequenceLeafItem {
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

  return {
    id: typeof record.id === 'string' && record.id ? record.id : createId('song'),
    kind: 'preset',
    artist,
    title,
    coverUrl,
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
    typeof record.activeItemId === 'string' && items.some((item) => item.id === record.activeItemId)
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
): ModoItalianoTextSequenceItem | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  if (record.kind === 'sequence') {
    const normalizedSequence = normalizeModoItalianoTextSequence(record.sequence, depth + 1, options);
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
): ModoItalianoSongSequenceItem | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  if (record.kind === 'sequence') {
    const normalizedSequence = normalizeModoItalianoSongSequence(record.sequence, depth + 1);
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
): number {
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

function resolveTextSequenceRecursive(
  sequence: ModoItalianoTextSequence,
  nowMs: number,
  depth: number,
  labels: string[]
): ModoItalianoResolvedTextLeaf | null {
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
  sequence: ModoItalianoSongSequence,
  nowMs: number,
  depth: number,
  labels: string[]
): ModoItalianoResolvedSongLeaf | null {
  if (depth > MAX_DEPTH) {
    return null;
  }

  const selected = getSelectedItem(sequence, nowMs);
  if (!selected) {
    return null;
  }

  if (selected.kind === 'sequence') {
    const nextLabels = [...labels, selected.label];
    return resolveSongSequenceRecursive(selected.sequence, nowMs, depth + 1, nextLabels);
  }

  const songLabel = [selected.artist, selected.title].filter(Boolean).join(' - ');
  return {
    artist: selected.artist,
    title: selected.title,
    coverUrl: selected.coverUrl,
    earoneSongId: selected.earoneSongId,
    earoneRank: selected.earoneRank,
    earoneSpins: selected.earoneSpins,
    activePathLabels: [...labels, songLabel || 'Song Preset']
  };
}

export function normalizeModoItalianoTextSequence(
  value: unknown,
  depth = 0,
  options?: { includeMarquee?: boolean }
): ModoItalianoTextSequence | null {
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
    .filter((item): item is ModoItalianoTextSequenceItem => item !== null);

  return withNormalizedSequenceShape(record, items);
}

export function normalizeModoItalianoSongSequence(
  value: unknown,
  depth = 0
): ModoItalianoSongSequence | null {
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
    .filter((item): item is ModoItalianoSongSequenceItem => item !== null);

  return withNormalizedSequenceShape(record, items);
}

export function createModoItalianoTextSequenceItem(
  kind: ModoItalianoTextSequenceItem['kind'] = 'preset',
  options?: { includeMarquee?: boolean }
): ModoItalianoTextSequenceItem {
  if (kind === 'sequence') {
    return {
      id: createId('sequence'),
      label: 'Nested Sequence',
      kind: 'sequence',
      sequence: createModoItalianoTextSequence('manual', options)
    };
  }

  return {
    id: createId('preset'),
    kind: 'preset',
    text: '',
    useMarquee: options?.includeMarquee ? false : undefined
  };
}

export function createModoItalianoSongSequenceItem(
  kind: ModoItalianoSongSequenceItem['kind'] = 'preset'
): ModoItalianoSongSequenceItem {
  if (kind === 'sequence') {
    return {
      id: createId('sequence'),
      label: 'Nested Sequence',
      kind: 'sequence',
      sequence: createModoItalianoSongSequence('manual')
    };
  }

  return {
    id: createId('song'),
    kind: 'preset',
    artist: '',
    title: '',
    coverUrl: ''
  };
}

export function createModoItalianoTextSequence(
  mode: ModoItalianoSequenceMode = 'manual',
  options?: { includeMarquee?: boolean }
): ModoItalianoTextSequence {
  const firstItem = createModoItalianoTextSequenceItem('preset', options);

  return {
    mode,
    items: [firstItem],
    activeItemId: firstItem.id,
    intervalMs: 4000,
    loop: true,
    startedAt: Date.now()
  };
}

export function createModoItalianoSongSequence(
  mode: ModoItalianoSequenceMode = 'manual'
): ModoItalianoSongSequence {
  const firstItem = createModoItalianoSongSequenceItem('preset');

  return {
    mode,
    items: [firstItem],
    activeItemId: firstItem.id,
    intervalMs: 4000,
    loop: true,
    startedAt: Date.now()
  };
}

export function getModoItalianoTextContentMode(
  contentMode: unknown,
  sequence: ModoItalianoTextSequence | null
): ModoItalianoTextContentMode {
  return normalizeTextContentMode(contentMode, sequence);
}

export function getModoItalianoSongContentMode(
  contentMode: unknown,
  sequence: ModoItalianoSongSequence | null
): ModoItalianoSongContentMode {
  return normalizeSongContentMode(contentMode, sequence);
}

export function getModoItalianoTextSequenceSelectedItemId(
  sequence: ModoItalianoTextSequence,
  nowMs = Date.now()
): string | null {
  return getSelectedItem(sequence, nowMs)?.id ?? null;
}

export function getModoItalianoSongSequenceSelectedItemId(
  sequence: ModoItalianoSongSequence,
  nowMs = Date.now()
): string | null {
  return getSelectedItem(sequence, nowMs)?.id ?? null;
}

export function resolveModoItalianoTextContent(
  config: {
    text?: string;
    useMarquee?: boolean;
    contentMode?: unknown;
    sequence?: unknown;
  },
  nowMs = Date.now(),
  options?: { includeMarquee?: boolean }
): ModoItalianoResolvedTextContent {
  const normalizedSequence = normalizeModoItalianoTextSequence(config.sequence, 0, options);
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

export function resolveModoItalianoTextLeaf(
  config: {
    contentMode?: unknown;
    sequence?: unknown;
  },
  nowMs = Date.now(),
  options?: { includeMarquee?: boolean }
): ModoItalianoResolvedTextLeaf | null {
  const normalizedSequence = normalizeModoItalianoTextSequence(config.sequence, 0, options);
  const contentMode = normalizeTextContentMode(config.contentMode, normalizedSequence);

  if (contentMode !== 'sequence' || !normalizedSequence) {
    return null;
  }

  return resolveTextSequenceRecursive(normalizedSequence, nowMs, 0, []);
}

export function resolveModoItalianoSongLeaf(
  config: {
    contentMode?: unknown;
    sequence?: unknown;
  },
  nowMs = Date.now()
): ModoItalianoResolvedSongLeaf | null {
  const normalizedSequence = normalizeModoItalianoSongSequence(config.sequence);
  const contentMode = normalizeSongContentMode(config.contentMode, normalizedSequence);

  if (contentMode !== 'sequence' || !normalizedSequence) {
    return null;
  }

  return resolveSongSequenceRecursive(normalizedSequence, nowMs, 0, []);
}

export function countModoItalianoTextSequenceLeafItems(
  sequence: ModoItalianoTextSequence | null
): number {
  if (!sequence) {
    return 0;
  }

  return sequence.items.reduce((count, item) => {
    if (item.kind === 'sequence') {
      return count + countModoItalianoTextSequenceLeafItems(item.sequence);
    }
    return count + 1;
  }, 0);
}

export function countModoItalianoSongSequenceLeafItems(
  sequence: ModoItalianoSongSequence | null
): number {
  if (!sequence) {
    return 0;
  }

  return sequence.items.reduce((count, item) => {
    if (item.kind === 'sequence') {
      return count + countModoItalianoSongSequenceLeafItems(item.sequence);
    }
    return count + 1;
  }, 0);
}
