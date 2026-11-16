export type ChartMetric = string | number | null | undefined;

export interface ChartValues {
  rank?: ChartMetric;
  spins?: ChartMetric;
}

/** The generic chart fields a song carries (see docs/generic-brand-fields.md). */
export interface ChartSongValues {
  externalChartId?: string;
  externalChartSongId?: string;
  externalChartRank?: string;
  externalChartSpins?: string;
}

function readChartField(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

/** Reads the generic chart fields from a stored song record, as trimmed strings. */
export function readChartSongValues(record: Record<string, unknown>): ChartSongValues {
  return {
    externalChartId: readChartField(record.externalChartId),
    externalChartSongId: readChartField(record.externalChartSongId),
    externalChartRank: readChartField(record.externalChartRank),
    externalChartSpins: readChartField(record.externalChartSpins)
  };
}

/**
 * The id used to find the song's realtime chart entry: the legacy chart id
 * when present, else the generic one. Without generic fields this is the
 * legacy id alone, as before.
 */
export function chartLookupId(legacyId: string | null | undefined, song: ChartSongValues | null | undefined): string | null {
  return legacyId || song?.externalChartId || song?.externalChartSongId || null;
}

/**
 * Chart rank and spins for the program page. Each value is chosen on its own,
 * taking the first one present: the scene's explicit value, the song's generic
 * field, the realtime chart entry, then the song's legacy field. A song without
 * generic fields resolves exactly as it did before they existed.
 */
export function resolveChartDisplay(sources: {
  scene?: ChartValues | null;
  song?: ChartSongValues | null;
  realtime?: ChartValues | null;
  legacy?: ChartValues | null;
}): ChartValues {
  const { scene, song, realtime, legacy } = sources;
  return {
    rank: scene?.rank || song?.externalChartRank || realtime?.rank || legacy?.rank,
    spins: scene?.spins || song?.externalChartSpins || realtime?.spins || legacy?.spins
  };
}
