// The Audio tab of the media library (gaulatti/alcantara#288, part B): what it shows of an
// asset's analysis, duration and capabilities, and how it filters them. Field names are the
// stored columns; nothing here is derived from data the API does not return.

/** The stored analysis of an audio asset (`MediaAssetAnalysis`). */
export interface AssetAnalysis {
  status: "success" | "pending" | "failed";
  cueInSeconds: number | null;
  cueOutSeconds: number | null;
  fadeInSeconds: number | null;
  fadeOutSeconds: number | null;
  overlapSeconds: number | null;
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  updatedAt?: string;
  /** Present only when the media list returns them. */
  error?: string | null;
  attempts?: number | null;
  nextAttemptAt?: string | null;
  isrc?: string | null;
  musicbrainzRecordingId?: string | null;
}

/**
 * What the list says about an asset's analysis: `undefined` when the response carries no
 * `analysis` at all (the server does not send it yet), `null` when the asset has no analysis row.
 */
export type AssetAnalysisField = AssetAnalysis | null | undefined;

export type AnalysisView =
  | "unavailable"
  | "none"
  | "measured"
  | "pending"
  | "failed";

export type AnalysisFilter = "all" | "measured" | "pending" | "failed";

export function analysisView(analysis: AssetAnalysisField): AnalysisView {
  if (analysis === undefined) return "unavailable";
  if (analysis === null) return "none";
  if (analysis.status === "success") return "measured";
  if (analysis.status === "pending") return "pending";
  return "failed";
}

/** The analysis when it is a finished measurement, otherwise null. */
export function measured(analysis: AssetAnalysisField): AssetAnalysis | null {
  return analysis && analysis.status === "success" ? analysis : null;
}

export const ANALYSIS_LABELS: Record<AnalysisView, string> = {
  unavailable: "Analysis unavailable",
  none: "Not analysed",
  measured: "Measured",
  pending: "Measuring",
  failed: "Failed",
};

/** Whole seconds as m:ss, or a dash when there is none. */
export function formatClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${rest < 10 ? "0" : ""}${rest}`;
}

/** A cue point as m:ss.s. */
export function formatCue(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
}

/** A level with an explicit sign for positive values, or a dash. */
export function formatSigned(
  value: number | null | undefined,
  digits = 1,
): string {
  if (value === null || value === undefined) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

export interface AudioAssetLike {
  id: string;
  name: string;
  capabilities: string[];
  labels: Array<{ id: string; name: string }>;
  song: { durationMs: number | null } | null;
  analysis?: AssetAnalysisField;
}

/** The asset's length, only where the library stores one (songs). */
export function durationSeconds(asset: AudioAssetLike): number | null {
  const ms = asset.song?.durationMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0
    ? ms / 1000
    : null;
}

/** How many of the listed assets fall in each analysis state. */
export function analysisCounts(
  assets: AudioAssetLike[],
): Record<AnalysisFilter, number> {
  const counts: Record<AnalysisFilter, number> = {
    all: assets.length,
    measured: 0,
    pending: 0,
    failed: 0,
  };
  for (const asset of assets) {
    const view = analysisView(asset.analysis);
    if (view === "measured" || view === "pending" || view === "failed")
      counts[view] += 1;
  }
  return counts;
}

export function filterByAnalysis<T extends AudioAssetLike>(
  assets: T[],
  filter: AnalysisFilter,
): T[] {
  if (filter === "all") return assets;
  return assets.filter((asset) => analysisView(asset.analysis) === filter);
}

/** A position as a share of the length, kept between 0 and 100. */
export function percentOf(seconds: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, (seconds / total) * 100));
}
