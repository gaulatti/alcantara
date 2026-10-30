import {
  cosineSimilarity,
  l2Normalize,
  markArtistPlayed,
  normalizeArtistCycle,
  normalizeArtistKey,
  normalizeSimilaritySettings,
  parseVectorLiteral,
  pickSimilarSong,
  toVectorLiteral,
  validateEmbeddingUploadHeader,
  validateEmbeddingUploadSong,
  EXPECTED_EMBEDDING_DIMENSION,
  SIMILARITY_MODEL,
  type SimilarityCandidate,
} from './song-similarity.utils';

const unit = (...v: number[]) => l2Normalize(v);
const candidate = (
  songId: number,
  artist: string,
  opening: number[] | null,
  blocked = false,
): SimilarityCandidate => ({
  songId,
  itemId: `item-${songId}`,
  artist,
  opening,
  blocked,
});

describe('cosine and normalization', () => {
  it('scores identical, orthogonal and opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('is scale invariant and rejects mismatched or zero vectors', () => {
    expect(cosineSimilarity([2, 0], [5, 0])).toBeCloseTo(1);
    expect(() => cosineSimilarity([1], [1, 2])).toThrow();
    expect(() => cosineSimilarity([0, 0], [1, 0])).toThrow();
  });

  it('L2-normalizes to unit length and rejects zero vectors', () => {
    const v = l2Normalize([3, 4]);
    expect(v[0] ** 2 + v[1] ** 2).toBeCloseTo(1);
    expect(() => l2Normalize([0, 0])).toThrow();
  });

  it('round-trips pgvector literals', () => {
    expect(parseVectorLiteral(toVectorLiteral([0.5, -0.25]))).toEqual([
      0.5, -0.25,
    ]);
    expect(() => parseVectorLiteral('0.5')).toThrow();
  });
});

describe('settings', () => {
  it('defaults to off and clamps invalid values', () => {
    expect(normalizeSimilaritySettings(null).mode).toBe('off');
    expect(normalizeSimilaritySettings({ mode: 'bogus' }).mode).toBe('off');
    expect(normalizeSimilaritySettings({ threshold: 7 }).threshold).toBe(0.8);
    expect(
      normalizeSimilaritySettings({ windowSeconds: 1 }).windowSeconds,
    ).toBe(30);
    expect(
      normalizeSimilaritySettings({ mode: 'on', pool: 'catalog' }),
    ).toMatchObject({ mode: 'on', pool: 'catalog' });
  });
});

describe('pickSimilarSong', () => {
  const closing = unit(1, 0, 0);
  const base = {
    currentClosing: closing,
    currentSongId: 1,
    currentArtist: 'Current',
    cycle: { artists: [] as string[] },
    threshold: 0.8,
  };

  it('picks the highest score that clears the threshold', () => {
    const result = pickSimilarSong({
      ...base,
      candidates: [
        candidate(2, 'A', unit(1, 0.5, 0)),
        candidate(3, 'B', unit(1, 0.1, 0)),
        candidate(4, 'C', unit(0, 1, 0)),
      ],
    });
    expect(result.outcome).toBe('selected');
    expect(result.chosen?.songId).toBe(3);
    expect(result.runnerUps.map((r) => r.songId)).toEqual([2]);
  });

  it('falls back when nothing clears the threshold', () => {
    const result = pickSimilarSong({
      ...base,
      candidates: [candidate(2, 'A', unit(0, 1, 0))],
    });
    expect(result).toMatchObject({
      outcome: 'fallback-no-candidate',
      chosen: null,
    });
  });

  it('falls back when the current song has no closing embedding', () => {
    const result = pickSimilarSong({
      ...base,
      currentClosing: null,
      candidates: [candidate(2, 'A', closing)],
    });
    expect(result.outcome).toBe('fallback-no-embedding');
  });

  it('ignores candidates without an opening embedding, blocked ones and the current song', () => {
    const result = pickSimilarSong({
      ...base,
      candidates: [
        candidate(1, 'Self', closing),
        candidate(2, 'A', null),
        candidate(3, 'B', closing, true),
      ],
    });
    expect(result.outcome).toBe('fallback-no-candidate');
  });

  it('only offers artists that have not played in the cycle', () => {
    const result = pickSimilarSong({
      ...base,
      cycle: { artists: [normalizeArtistKey('Álvaro')] },
      candidates: [
        candidate(2, 'ALVARO', closing),
        candidate(3, 'Other', unit(1, 0.4, 0)),
      ],
    });
    expect(result.chosen?.songId).toBe(3);
    expect(result.cycleReset).toBe(false);
  });

  it('starts a new cycle once every artist has played, never repeating the current artist', () => {
    const result = pickSimilarSong({
      ...base,
      cycle: { artists: ['current', 'a', 'b'] },
      candidates: [
        candidate(2, 'A', closing),
        candidate(3, 'B', unit(1, 0.1, 0)),
        candidate(4, 'Current', closing),
      ],
    });
    expect(result.cycleReset).toBe(true);
    expect(result.chosen?.songId).toBe(2);
    expect(result.chosen?.songId).not.toBe(4);
  });

  it('does not constrain songs without an artist name', () => {
    const result = pickSimilarSong({
      ...base,
      cycle: { artists: ['a'] },
      candidates: [candidate(2, '', closing)],
    });
    expect(result.chosen?.songId).toBe(2);
  });

  it('is deterministic on ties', () => {
    const result = pickSimilarSong({
      ...base,
      candidates: [candidate(9, 'B', closing), candidate(5, 'A', closing)],
    });
    expect(result.chosen?.songId).toBe(5);
  });
});

describe('artist cycle state', () => {
  it('marks, deduplicates and ignores empty artists', () => {
    let cycle = normalizeArtistCycle(null);
    cycle = markArtistPlayed(cycle, 'Pino Daniele');
    cycle = markArtistPlayed(cycle, ' pino  DANIELE ');
    cycle = markArtistPlayed(cycle, '');
    expect(cycle.artists).toEqual(['pino daniele']);
  });

  it('sanitizes persisted state', () => {
    expect(
      normalizeArtistCycle({ artists: ['a', 3, '', 'a'] }).artists,
    ).toEqual(['a']);
    expect(normalizeArtistCycle('x').artists).toEqual([]);
  });
});

describe('embedding upload validation', () => {
  const vec = () => {
    const v = new Array(EXPECTED_EMBEDDING_DIMENSION).fill(0);
    v[0] = 1;
    return v;
  };
  const sha = 'a'.repeat(64);

  it('accepts a well-formed song and rejects bad dimension, norm and hash', () => {
    expect(
      validateEmbeddingUploadSong({
        songId: 1,
        audioSha256: sha,
        opening: vec(),
        closing: vec(),
      }).ok,
    ).toBe(true);
    expect(
      validateEmbeddingUploadSong({
        songId: 1,
        audioSha256: sha,
        opening: [1, 0],
        closing: vec(),
      }).ok,
    ).toBe(false);
    expect(
      validateEmbeddingUploadSong({
        songId: 1,
        audioSha256: sha,
        opening: vec().map((v) => v * 2),
        closing: vec(),
      }).ok,
    ).toBe(false);
    expect(
      validateEmbeddingUploadSong({
        songId: 1,
        audioSha256: 'zz',
        opening: vec(),
        closing: vec(),
      }).ok,
    ).toBe(false);
  });

  it('requires the known model, version, license and a sane window', () => {
    const header = {
      schema: 1,
      model: { ...SIMILARITY_MODEL },
      windowSeconds: 30,
      songs: [],
    };
    expect(validateEmbeddingUploadHeader(header).ok).toBe(true);
    expect(
      validateEmbeddingUploadHeader({
        ...header,
        model: { ...SIMILARITY_MODEL, name: 'other' },
      }).ok,
    ).toBe(false);
    expect(
      validateEmbeddingUploadHeader({ ...header, windowSeconds: 1 }).ok,
    ).toBe(false);
  });
});
