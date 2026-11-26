// How fresh the engine's output level must be for the desk to call it detected (gaulatti/alcantara#706).

/**
 * After this long without a fresh level sample, audible output is shown as unverified and the on-air clock is
 * dimmed. Display only: the backend's own thresholds (a stale sample after 15 s, silence after 10 s) still decide
 * Status delayed and dead air.
 */
export const OUTPUT_SAMPLE_UNVERIFIED_MS = 6_000;

/** Audible output whose last level sample is older than OUTPUT_SAMPLE_UNVERIFIED_MS (or missing). */
export function isOutputSampleUnverified(
  output: { state: string; lastSampleAt: string | null } | null,
  now: number,
): boolean {
  if (output?.state !== "audible") return false;
  const sampledAt = output.lastSampleAt ? Date.parse(output.lastSampleAt) : NaN;
  return !Number.isFinite(sampledAt) || now - sampledAt > OUTPUT_SAMPLE_UNVERIFIED_MS;
}
