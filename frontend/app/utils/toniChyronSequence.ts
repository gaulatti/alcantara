export type ToniChyronContentMode = 'text' | 'sequence';
export type ToniChyronSequenceMode = 'manual' | 'autoplay';

export interface ToniChyronSequenceLeafItem {
  id: string;
  kind: 'preset';
  text: string;
  useMarquee?: boolean;
  earoneSongId?: string;
  earoneRank?: string;
  earoneSpins?: string;
}

export interface ToniChyronSequenceNestedItem {
  id: string;
  label: string;
  kind: 'sequence';
  sequence: ToniChyronSequence;
}

export type ToniChyronSequenceItem =
  | ToniChyronSequenceLeafItem
  | ToniChyronSequenceNestedItem;

export interface ToniChyronSequence {
  mode: ToniChyronSequenceMode;
  items: ToniChyronSequenceItem[];
  activeItemId?: string | null;
  intervalMs?: number;
  loop?: boolean;
  startedAt?: number;
}

export interface ToniChyronResolvedContent {
  text: string;
  useMarquee: boolean;
  source: ToniChyronContentMode;
  activePathLabels: string[];
}

export interface ToniChyronResolvedLeaf {
  text: string;
  useMarquee: boolean;
  earoneSongId?: string;
  earoneRank?: string;
  earoneSpins?: string;
  activePathLabels: string[];
}

type RecordValue = Record<string, unknown>;

const MAX_DEPTH = 8;

function asRecord(value: unknown): RecordValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as RecordValue;
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeMode(value: unknown): ToniChyronSequenceMode {
  return value === 'autoplay' ? 'autoplay' : 'manual';
}

function normalizeLeafItem(record: RecordValue): ToniChyronSequenceLeafItem {
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
    useMarquee: Boolean(record.useMarquee),
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

function normalizeSequenceItem(value: unknown, depth: number): ToniChyronSequenceItem | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  if (record.kind === 'sequence') {
    const normalizedSequence = normalizeToniChyronSequence(record.sequence, depth + 1);
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

  return normalizeLeafItem(record);
}

export function normalizeToniChyronSequence(
  value: unknown,
  depth = 0
): ToniChyronSequence | null {
  if (depth > MAX_DEPTH) {
    return null;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const rawItems = Array.isArray(record.items) ? record.items : [];
  const items = rawItems
    .map((item) => normalizeSequenceItem(item, depth))
    .filter((item): item is ToniChyronSequenceItem => item !== null);

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

export function createToniChyronSequenceItem(
  kind: ToniChyronSequenceItem['kind'] = 'preset'
): ToniChyronSequenceItem {
  if (kind === 'sequence') {
    return {
      id: createId('sequence'),
      label: 'Nested Sequence',
      kind: 'sequence',
      sequence: createToniChyronSequence('manual')
    };
  }

  return {
    id: createId('preset'),
    kind: 'preset',
    text: '',
    useMarquee: false
  };
}

export function createToniChyronSequence(
  mode: ToniChyronSequenceMode = 'manual'
): ToniChyronSequence {
  const firstItem = createToniChyronSequenceItem('preset');

  return {
    mode,
    items: [firstItem],
    activeItemId: firstItem.id,
    intervalMs: 4000,
    loop: true,
    startedAt: Date.now()
  };
}

function getBaseIndex(sequence: ToniChyronSequence): number {
  const activeIndex = sequence.items.findIndex((item) => item.id === sequence.activeItemId);
  return activeIndex >= 0 ? activeIndex : 0;
}

function getSelectedItem(
  sequence: ToniChyronSequence,
  nowMs: number
): ToniChyronSequenceItem | null {
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

export function getToniChyronSequenceSelectedItemId(
  sequence: ToniChyronSequence,
  nowMs = Date.now()
): string | null {
  return getSelectedItem(sequence, nowMs)?.id ?? null;
}

function resolveSequenceRecursive(
  sequence: ToniChyronSequence,
  nowMs: number,
  depth: number,
  labels: string[]
): ToniChyronResolvedLeaf | null {
  if (depth > MAX_DEPTH) {
    return null;
  }

  const selected = getSelectedItem(sequence, nowMs);
  if (!selected) {
    return null;
  }

  if (selected.kind === 'sequence') {
    const nextLabels = [...labels, selected.label];
    return resolveSequenceRecursive(selected.sequence, nowMs, depth + 1, nextLabels);
  }

  return {
    text: selected.text,
    useMarquee: Boolean(selected.useMarquee),
    earoneSongId: selected.earoneSongId,
    earoneRank: selected.earoneRank,
    earoneSpins: selected.earoneSpins,
    activePathLabels: [...labels, selected.text]
  };
}

export function getToniChyronContentMode(
  contentMode: unknown,
  sequence: ToniChyronSequence | null
): ToniChyronContentMode {
  if (contentMode === 'text') {
    return 'text';
  }
  if (contentMode === 'sequence') {
    return 'sequence';
  }
  return sequence ? 'sequence' : 'text';
}

export function resolveToniChyronContent(config: {
  text?: string;
  useMarquee?: boolean;
  contentMode?: unknown;
  sequence?: unknown;
}, nowMs = Date.now()): ToniChyronResolvedContent {
  const normalizedSequence = normalizeToniChyronSequence(config.sequence);
  const contentMode = getToniChyronContentMode(config.contentMode, normalizedSequence);

  if (contentMode === 'sequence' && normalizedSequence) {
    const resolved = resolveSequenceRecursive(normalizedSequence, nowMs, 0, []);
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

export function resolveToniChyronLeaf(config: {
  contentMode?: unknown;
  sequence?: unknown;
}, nowMs = Date.now()): ToniChyronResolvedLeaf | null {
  const normalizedSequence = normalizeToniChyronSequence(config.sequence);
  const contentMode = getToniChyronContentMode(config.contentMode, normalizedSequence);

  if (contentMode !== 'sequence' || !normalizedSequence) {
    return null;
  }

  return resolveSequenceRecursive(normalizedSequence, nowMs, 0, []);
}

export function countSequenceLeafItems(sequence: ToniChyronSequence | null): number {
  if (!sequence) {
    return 0;
  }

  return sequence.items.reduce((count, item) => {
    if (item.kind === 'sequence') {
      return count + countSequenceLeafItems(item.sequence);
    }
    return count + 1;
  }, 0);
}
