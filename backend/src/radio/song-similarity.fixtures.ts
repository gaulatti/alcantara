/**
 * Evaluation pairs for the similarity picker, referenced by song ID.
 *
 * TODO(operator): replace the empty lists with pairs from the Modo Italiano
 * catalog. `mustRankHigh` pairs must score at or above the threshold;
 * `mustNeverPass` pairs must stay below it. Each pair is
 * [currentSongId, candidateSongId]. The evaluation spec skips empty lists and
 * only runs them against embeddings loaded from a local export.
 */
export const SIMILARITY_EVALUATION_PAIRS: {
  mustRankHigh: [number, number][];
  mustNeverPass: [number, number][];
} = {
  mustRankHigh: [],
  mustNeverPass: [],
};
