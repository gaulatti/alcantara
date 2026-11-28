import { resolve } from './flight-resolver';
import type { FlightCue } from './flight.types';

/**
 * How long after its start a sequence's first pass through `items` ends, by the resolver's own timeline: the first
 * millisecond at which a non-looping run of them is finished (gaulatti/alcantara#123). Given the items up to a cue,
 * it is when that cue ends.
 */
export function passEndsAfterMs(
  items: FlightCue[],
  songDurationsMs: ReadonlyMap<number, number>,
): number {
  const finished = (elapsedMs: number) =>
    resolve({ items, loop: false }, 0, elapsedMs, songDurationsMs).finished;
  let over = 1;
  while (!finished(over)) over *= 2;
  let under = -1;
  while (over - under > 1) {
    const middle = Math.floor((under + over) / 2);
    if (finished(middle)) over = middle;
    else under = middle;
  }
  return over;
}
