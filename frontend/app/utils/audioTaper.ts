interface TaperPoint {
  fader: number;
  db: number;
}

const CONSOLE_SILENCE_DB = -80;
const METER_FLOOR_DB = -24;
const METER_VISUAL_CURVE = 1.6;
const CONSOLE_TAPER: TaperPoint[] = [
  { fader: 0.03, db: -70 },
  { fader: 0.12, db: -45 },
  { fader: 0.28, db: -28 },
  { fader: 0.5, db: -15 },
  { fader: 0.72, db: -8 },
  { fader: 0.88, db: -3 },
  { fader: 1, db: 0 }
];

export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(0, Math.min(1, value));
}

function interpolateLinear(from: number, to: number, ratio: number): number {
  return from + (to - from) * ratio;
}

export function gainToDb(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return Number.NEGATIVE_INFINITY;
  }
  return 20 * Math.log10(value);
}

export function dbToGain(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.pow(10, value / 20);
}

export function faderToDb(value: number): number {
  const normalized = clampUnit(value);
  if (normalized <= 0) {
    return Number.NEGATIVE_INFINITY;
  }

  if (normalized >= 1) {
    return 0;
  }

  const firstPoint = CONSOLE_TAPER[0];
  if (normalized <= firstPoint.fader) {
    const ratio = normalized / firstPoint.fader;
    return interpolateLinear(CONSOLE_SILENCE_DB, firstPoint.db, ratio);
  }

  for (let index = 1; index < CONSOLE_TAPER.length; index += 1) {
    const previous = CONSOLE_TAPER[index - 1];
    const next = CONSOLE_TAPER[index];
    if (normalized <= next.fader) {
      const ratio = (normalized - previous.fader) / (next.fader - previous.fader);
      return interpolateLinear(previous.db, next.db, ratio);
    }
  }

  return 0;
}

export function dbToFader(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value <= CONSOLE_SILENCE_DB) {
    return 0;
  }

  if (value >= 0) {
    return 1;
  }

  const firstPoint = CONSOLE_TAPER[0];
  if (value <= firstPoint.db) {
    const ratio = (value - CONSOLE_SILENCE_DB) / (firstPoint.db - CONSOLE_SILENCE_DB);
    return clampUnit(interpolateLinear(0, firstPoint.fader, ratio));
  }

  for (let index = 1; index < CONSOLE_TAPER.length; index += 1) {
    const previous = CONSOLE_TAPER[index - 1];
    const next = CONSOLE_TAPER[index];
    if (value <= next.db) {
      const ratio = (value - previous.db) / (next.db - previous.db);
      return clampUnit(interpolateLinear(previous.fader, next.fader, ratio));
    }
  }

  return 1;
}

export function faderToGain(value: number): number {
  const db = faderToDb(value);
  if (!Number.isFinite(db)) {
    return 0;
  }
  return dbToGain(db);
}

export function formatGainDb(value: number): string {
  const db = gainToDb(value);
  if (!Number.isFinite(db)) {
    return '-inf dB';
  }
  return `${db.toFixed(1)} dB`;
}

export function gainToMeterFill(value: number): number {
  const db = gainToDb(value);
  if (!Number.isFinite(db)) {
    return 0;
  }
  const normalized = clampUnit((db - METER_FLOOR_DB) / (0 - METER_FLOOR_DB));
  return clampUnit(Math.pow(normalized, METER_VISUAL_CURVE));
}

export function interpolateGainLog(from: number, to: number, ratio: number): number {
  const normalizedRatio = clampUnit(ratio);
  if (normalizedRatio <= 0) {
    return Math.max(0, from);
  }
  if (normalizedRatio >= 1) {
    return Math.max(0, to);
  }

  const fromDb = from <= 0 ? CONSOLE_SILENCE_DB : gainToDb(from);
  const toDb = to <= 0 ? CONSOLE_SILENCE_DB : gainToDb(to);
  const currentDb = interpolateLinear(fromDb, toDb, normalizedRatio);
  return dbToGain(currentDb);
}
