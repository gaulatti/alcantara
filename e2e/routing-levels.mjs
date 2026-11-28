// The level verdicts of routing-proof.mjs, apart so they are tested on their own.

/** Level, in linear magnitude, above which a tone is present in a return. */
export const PRESENT = 0.002;
/** How far a measured gain may land from the one set, as a ratio either way: about ±3.5 dB. */
export const GAIN_TOLERANCE = 1.5;

/** Whether a source's level in a return moved by the gain set: `unity` at gain 1, `measured` at `gain`. */
export function gainVerdict(unity, measured, gain) {
  const ratio = unity > 0 ? measured / unity : 0;
  const round = (value) => Number(value.toFixed(5));
  return {
    ok:
      unity >= PRESENT &&
      ratio >= gain / GAIN_TOLERANCE &&
      ratio <= gain * GAIN_TOLERANCE,
    unity: round(unity),
    measured: round(measured),
    set: gain,
    ratio: Number(ratio.toFixed(3)),
    db: ratio > 0 ? Number((20 * Math.log10(ratio)).toFixed(1)) : null,
  };
}

/** Whether a source is heard (`expected` true) or absent (false) in a return, from its tone's level. */
export function presentVerdict(level, expected) {
  const present = level >= PRESENT;
  return {
    ok: present === expected,
    level: Number(level.toFixed(5)),
    expected: expected ? "present" : "absent",
  };
}
