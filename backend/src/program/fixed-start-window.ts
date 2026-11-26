/**
 * The fixed-start window of a timed block (#788, MCP parity item 4): the rule the rundown desk applies as an
 * operator types a fixed start (frontend/app/utils/fixedStart.ts, D3), enforced where both the console and MCP
 * save a block. A block has no end, so a fixed start must fall within FIXED_START_MAX_HOURS of its own start
 * and before the next scheduled block. Starts before the block are already refused by the clock-log ordering
 * rule. The backend knows no browser time zone, so its messages name offsets and UTC times where the desk
 * names local clock times.
 */
export const FIXED_START_MAX_HOURS = 6;

const HOUR_MS = 3_600_000;

/** "+15:30" for 930 s, as the rundown shows an offset. */
function offset(seconds: number): string {
  return `+${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function fixedStartWindowRefusal(
  items: { clockOffsetSeconds?: number }[],
  scheduledAt: Date,
  nextScheduledAt: Date | null,
): string | null {
  const startMs = scheduledAt.getTime();
  for (const item of items) {
    const seconds = item.clockOffsetSeconds;
    if (seconds === undefined) continue;
    if (seconds * 1000 >= FIXED_START_MAX_HOURS * HOUR_MS)
      return `A fixed start at ${offset(seconds)} is more than ${FIXED_START_MAX_HOURS} hours after this block starts at ${scheduledAt.toISOString()}.`;
    if (nextScheduledAt && startMs + seconds * 1000 >= nextScheduledAt.getTime())
      return `A fixed start at ${offset(seconds)} is after the next block starts at ${nextScheduledAt.toISOString()}.`;
  }
  return null;
}
