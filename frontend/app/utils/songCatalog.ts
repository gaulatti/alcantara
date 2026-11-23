// The Song catalog (gaulatti/alcantara#302): honest counts, lengths and runtime. A song with no
// stored length is counted as such; nothing is guessed from its audio file.

export interface LengthSource {
  durationMs: number | null;
  /** The decoded length of the stored analysis (#296), when the list carries it. */
  analysis?: { durationSeconds?: number | null } | null;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/** The song's length in seconds: the analysis's `durationSeconds` when present, else `durationMs`. */
export function songLengthSeconds(song: LengthSource): number | null {
  const analysed = positive(song.analysis?.durationSeconds);
  if (analysed !== null) return analysed;
  const ms = positive(song.durationMs);
  return ms === null ? null : ms / 1000;
}

/** m:ss, or h:mm:ss from an hour. */
export function formatLength(seconds: number | null): string {
  if (seconds === null) return "—";
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${minutes}:${pad(rest)}`;
}

/** The total runtime of the known lengths as h:mm. */
export function formatRuntime(totalMs: number): string {
  const minutesTotal = Math.max(0, Math.floor(totalMs / 60_000));
  return `${Math.floor(minutesTotal / 60)}:${String(minutesTotal % 60).padStart(2, "0")}`;
}

export interface CatalogCounts {
  total: number;
  enabled: number;
  withLength: number;
  withoutLength: number;
}

/** The strip's counts from the server's catalog totals, never from the page being viewed. */
export function catalogCounts(meta: {
  catalogTotal: number;
  catalogEnabled: number;
  catalogKnownDurationCount: number;
}): CatalogCounts {
  const withLength = Math.min(
    meta.catalogKnownDurationCount,
    meta.catalogTotal,
  );
  return {
    total: meta.catalogTotal,
    enabled: meta.catalogEnabled,
    withLength,
    withoutLength: Math.max(0, meta.catalogTotal - withLength),
  };
}
