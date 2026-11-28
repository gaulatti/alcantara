// The tones and the mix-minus verdict of three-guest-proof.mjs, apart so they are tested on their own.

/**
 * Each guest's microphone plays one tone. The frequencies share no low harmonic, and sit well apart from each other
 * and from 440 Hz, the tone every other synthetic participant plays.
 */
export const TONE_GUESTS = [
  { name: "A", hz: 520 },
  { name: "B", hz: 990 },
  { name: "C", hz: 1340 },
];

/** Level, in linear magnitude, above which a tone is present in a return. */
export const PRESENT = 0.002;
/** A guest's own tone counts as absent when it is at least this far below the quietest other guest's: 20 dB. */
export const OWN_BELOW = 0.1;

/**
 * Whether a guest's return is a correct mix-minus: every other guest's tone is present, and its own is absent (no
 * self-echo, delayed or not). `spectrum` is { samples, levels: { [hz]: level } } as the guest page measured it.
 */
export function analyseTones(guest, guests, spectrum) {
  const levels = spectrum?.levels ?? {};
  const others = guests.filter((other) => other.name !== guest.name);
  const otherLevels = Object.fromEntries(
    others.map((other) => [other.name, levels[other.hz] ?? 0]),
  );
  const own = levels[guest.hz] ?? 0;
  const quietestOther = Math.min(...Object.values(otherLevels));
  const othersPresent = Object.values(otherLevels).every(
    (level) => level >= PRESENT,
  );
  const ownAbsent = own <= quietestOther * OWN_BELOW;
  const round = (value) => Number(value.toFixed(5));
  return {
    ok: Boolean(spectrum?.samples) && othersPresent && ownAbsent,
    guest: guest.name,
    samples: spectrum?.samples ?? 0,
    hears: Object.fromEntries(
      Object.entries(otherLevels).map(([name, level]) => [name, round(level)]),
    ),
    own: round(own),
    othersPresent,
    ownAbsent,
  };
}
