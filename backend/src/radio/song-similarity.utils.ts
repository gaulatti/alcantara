export const SIMILARITY_MODEL = {
  name: 'discogs-effnet-bs64-1',
  version: '1',
  license: 'CC BY-NC-SA 4.0',
} as const;

export const SIMILARITY_MODES = ['off', 'shadow', 'on'] as const;
export type SimilarityMode = (typeof SIMILARITY_MODES)[number];
export const SIMILARITY_POOLS = ['sequence', 'catalog'] as const;
export type SimilarityPool = (typeof SIMILARITY_POOLS)[number];
export const SIMILARITY_SEGMENTS = ['opening', 'closing'] as const;
export type SimilaritySegment = (typeof SIMILARITY_SEGMENTS)[number];

export const MIN_WINDOW_SECONDS = 5;
export const MAX_WINDOW_SECONDS = 120;
export const MAX_ARTIST_CYCLE_ENTRIES = 4000;
/** Prefix of the engine item id used for a song played from outside the playlist. */
export const CATALOG_ITEM_PREFIX = 'catalog:';
export const RUNNER_UP_COUNT = 3;

export interface SimilaritySettings {
  mode: SimilarityMode;
  threshold: number;
  windowSeconds: number;
  pool: SimilarityPool;
}

export const DEFAULT_SIMILARITY_SETTINGS: SimilaritySettings = {
  mode: 'off',
  threshold: 0.8,
  windowSeconds: 30,
  pool: 'sequence',
};

export function normalizeSimilaritySettings(
  value: Partial<Record<keyof SimilaritySettings, unknown>> | null | undefined,
): SimilaritySettings {
  const mode = SIMILARITY_MODES.find((m) => m === value?.mode) ?? 'off';
  const pool = SIMILARITY_POOLS.find((p) => p === value?.pool) ?? 'sequence';
  const threshold =
    typeof value?.threshold === 'number' &&
    Number.isFinite(value.threshold) &&
    value.threshold >= -1 &&
    value.threshold <= 1
      ? value.threshold
      : DEFAULT_SIMILARITY_SETTINGS.threshold;
  const windowSeconds =
    typeof value?.windowSeconds === 'number' &&
    Number.isInteger(value.windowSeconds) &&
    value.windowSeconds >= MIN_WINDOW_SECONDS &&
    value.windowSeconds <= MAX_WINDOW_SECONDS
      ? value.windowSeconds
      : DEFAULT_SIMILARITY_SETTINGS.windowSeconds;
  return { mode, threshold, windowSeconds, pool };
}

export function l2Norm(vector: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  return Math.sqrt(sum);
}

export function l2Normalize(vector: ArrayLike<number>): number[] {
  const norm = l2Norm(vector);
  if (!(norm > 0)) throw new Error('cannot normalize a zero vector');
  return Array.from(vector, (v) => v / norm);
}

/** Cosine similarity; defined only for equally long, non-zero vectors. */
export function cosineSimilarity(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): number {
  if (a.length !== b.length || a.length === 0) {
    throw new Error('vectors must be non-empty and have the same dimension');
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!(na > 0) || !(nb > 0)) throw new Error('zero vector');
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function normalizeArtistKey(artist: string | null | undefined): string {
  return (artist ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Artists that have played in the current cycle (normalized, bounded). */
export interface ArtistCycleState {
  artists: string[];
}

export function normalizeArtistCycle(value: unknown): ArtistCycleState {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).artists
      : null;
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string' && entry && entry.length <= 200) {
        seen.add(entry);
      }
    }
  }
  return { artists: [...seen].slice(-MAX_ARTIST_CYCLE_ENTRIES) };
}

export function markArtistPlayed(
  cycle: ArtistCycleState,
  artist: string | null | undefined,
): ArtistCycleState {
  const key = normalizeArtistKey(artist);
  if (!key || cycle.artists.includes(key)) return cycle;
  return {
    artists: [...cycle.artists, key].slice(-MAX_ARTIST_CYCLE_ENTRIES),
  };
}

export interface SimilarityCandidate {
  songId: number;
  /** Playlist item id, or `catalog:<songId>` for a song outside the playlist. */
  itemId: string;
  artist: string;
  opening: ArrayLike<number> | null;
  /** True when a rotation rule (e.g. high-rotation cooldown) forbids it now. */
  blocked: boolean;
}

export interface SimilarityRanked {
  songId: number;
  itemId: string;
  score: number;
}

export type SimilarityOutcome =
  | 'selected'
  | 'fallback-no-embedding'
  | 'fallback-no-candidate';

export interface SimilarityPickResult {
  outcome: SimilarityOutcome;
  chosen: SimilarityRanked | null;
  runnerUps: SimilarityRanked[];
  /** True when every artist had already played and a new cycle was started. */
  cycleReset: boolean;
}

/**
 * Chooses the next song by cosine(current.closing, candidate.opening).
 *
 * Artist rule: only artists that have not played in the current cycle are
 * eligible. When none remains, every artist has played: a new cycle starts
 * containing only the current artist, so no artist repeats back to back.
 * Pure: it never mutates the cycle; callers apply `cycleReset`.
 */
export function pickSimilarSong(input: {
  currentClosing: ArrayLike<number> | null;
  currentSongId: number | null;
  currentArtist: string;
  candidates: SimilarityCandidate[];
  cycle: ArtistCycleState;
  threshold: number;
}): SimilarityPickResult {
  const none = (outcome: SimilarityOutcome, cycleReset = false) => ({
    outcome,
    chosen: null,
    runnerUps: [],
    cycleReset,
  });
  if (!input.currentClosing) return none('fallback-no-embedding');

  const usable = input.candidates.filter(
    (c) =>
      c.opening !== null &&
      !c.blocked &&
      (input.currentSongId === null || c.songId !== input.currentSongId),
  );
  const eligibleFor = (played: Set<string>) =>
    usable.filter((c) => {
      const key = normalizeArtistKey(c.artist);
      return !key || !played.has(key);
    });

  let played = new Set(input.cycle.artists);
  let eligible = eligibleFor(played);
  let cycleReset = false;
  if (!eligible.length && usable.length) {
    cycleReset = true;
    const currentKey = normalizeArtistKey(input.currentArtist);
    played = new Set(currentKey ? [currentKey] : []);
    eligible = eligibleFor(played);
  }

  const ranked: SimilarityRanked[] = eligible
    .map((c) => ({
      songId: c.songId,
      itemId: c.itemId,
      score: cosineSimilarity(input.currentClosing!, c.opening!),
    }))
    .filter((c) => c.score >= input.threshold)
    .sort((a, b) => b.score - a.score || a.songId - b.songId);

  if (!ranked.length) return none('fallback-no-candidate', cycleReset);
  return {
    outcome: 'selected',
    chosen: ranked[0],
    runnerUps: ranked.slice(1, 1 + RUNNER_UP_COUNT),
    cycleReset,
  };
}

export interface EmbeddingUploadSong {
  songId: number;
  audioSha256: string;
  opening: number[];
  closing: number[];
}

export interface EmbeddingUploadPayload {
  schema: 1;
  model: { name: string; version: string; license: string };
  windowSeconds: number;
  songs: EmbeddingUploadSong[];
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const EXPECTED_EMBEDDING_DIMENSION = 1280;
const NORM_TOLERANCE = 1e-3;

export type EmbeddingValidation = { ok: true } | { ok: false; reason: string };

export function validateEmbeddingVector(
  vector: unknown,
  dimension = EXPECTED_EMBEDDING_DIMENSION,
): EmbeddingValidation {
  if (!Array.isArray(vector) || vector.length !== dimension) {
    return { ok: false, reason: `vector must have ${dimension} dimensions` };
  }
  if (!vector.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return { ok: false, reason: 'vector contains non-finite values' };
  }
  if (Math.abs(l2Norm(vector as number[]) - 1) > NORM_TOLERANCE) {
    return { ok: false, reason: 'vector is not L2-normalized' };
  }
  return { ok: true };
}

export function validateEmbeddingUploadHeader(
  payload: unknown,
): EmbeddingValidation {
  const p = payload as Partial<EmbeddingUploadPayload> | null;
  if (!p || typeof p !== 'object' || p.schema !== 1) {
    return { ok: false, reason: 'unsupported schema' };
  }
  if (
    p.model?.name !== SIMILARITY_MODEL.name ||
    p.model?.version !== SIMILARITY_MODEL.version ||
    p.model?.license !== SIMILARITY_MODEL.license
  ) {
    return { ok: false, reason: 'unknown model, version or license' };
  }
  if (
    !Number.isInteger(p.windowSeconds) ||
    (p.windowSeconds as number) < MIN_WINDOW_SECONDS ||
    (p.windowSeconds as number) > MAX_WINDOW_SECONDS
  ) {
    return { ok: false, reason: 'invalid windowSeconds' };
  }
  if (!Array.isArray(p.songs)) return { ok: false, reason: 'songs required' };
  return { ok: true };
}

export function validateEmbeddingUploadSong(
  song: unknown,
): EmbeddingValidation {
  const s = song as Partial<EmbeddingUploadSong> | null;
  if (!s || typeof s !== 'object')
    return { ok: false, reason: 'invalid entry' };
  if (!Number.isInteger(s.songId) || (s.songId as number) <= 0) {
    return { ok: false, reason: 'invalid songId' };
  }
  if (
    typeof s.audioSha256 !== 'string' ||
    !SHA256_PATTERN.test(s.audioSha256)
  ) {
    return { ok: false, reason: 'invalid audioSha256' };
  }
  for (const segment of SIMILARITY_SEGMENTS) {
    const result = validateEmbeddingVector(s[segment]);
    if (!result.ok)
      return { ok: false, reason: `${segment}: ${result.reason}` };
  }
  return { ok: true };
}

/** pgvector text literal: `[0.1,0.2,...]`. */
export function toVectorLiteral(vector: ArrayLike<number>): string {
  return `[${Array.from(vector).join(',')}]`;
}

export function parseVectorLiteral(text: string): number[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new Error('invalid vector literal');
  }
  const body = trimmed.slice(1, -1);
  return body ? body.split(',').map(Number) : [];
}
