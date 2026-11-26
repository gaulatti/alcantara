/**
 * The fixed start a timed block's event is pinned to (the walk's D3). The
 * operator types a clock time (07:25 or 07:25:30, in the browser's local time
 * like the timeline's labels), an offset with its plus sign (+15:30), or plain
 * seconds (930); what is stored stays the seconds from the block start.
 * A block has no end, so a fixed start must land before the next scheduled
 * block and within FIXED_START_MAX_HOURS of its own start.
 */
export const FIXED_START_MAX_HOURS = 6;

export type FixedStartResult =
  | { ok: true; seconds: number }
  | { ok: false; message: string };

const HOUR_MS = 3_600_000;

function clock(ms: number, seconds = false): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    // h23, not hour12: false, which some locales render as 24:10 after midnight.
    hourCycle: "h23",
  });
}

/** The clock time an offset lands on, with seconds: "07:25:30". */
export function fixedStartClock(scheduledAt: string, seconds: number): string {
  return clock(Date.parse(scheduledAt) + seconds * 1000, true);
}

export function parseFixedStart(
  text: string,
  scheduledAt: string,
  nextScheduledAt: string | null,
): FixedStartResult {
  const entry = text.trim();
  const startMs = Date.parse(scheduledAt);
  const maxMs = FIXED_START_MAX_HOURS * HOUR_MS;
  let offsetMs: number;
  const offset = /^\+?(\d+)$/.exec(entry) ?? /^\+(\d+):([0-5]\d)$/.exec(entry);
  const time = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/.exec(entry);
  if (offset) {
    offsetMs =
      (offset[2] === undefined
        ? Number(offset[1])
        : Number(offset[1]) * 60 + Number(offset[2])) * 1000;
  } else if (time && Number(time[1]) < 24) {
    const sameDay = new Date(startMs);
    sameDay.setHours(Number(time[1]), Number(time[2]), Number(time[3] ?? 0), 0);
    const at = new Date(sameDay);
    if (at.getTime() < startMs) at.setDate(at.getDate() + 1);
    offsetMs = at.getTime() - startMs;
    if (sameDay.getTime() < startMs && startMs - sameDay.getTime() <= maxMs)
      return {
        ok: false,
        message: `${entry} is before this block starts at ${clock(startMs)}.`,
      };
  } else {
    return {
      ok: false,
      message:
        "Enter a clock time (07:10 or 07:10:30), an offset (+05:00) or seconds.",
    };
  }
  if (offsetMs >= maxMs)
    return {
      ok: false,
      message: `${entry} is more than ${FIXED_START_MAX_HOURS} hours after this block starts at ${clock(startMs)}.`,
    };
  if (nextScheduledAt && startMs + offsetMs >= Date.parse(nextScheduledAt))
    return {
      ok: false,
      message: `${entry} is after the next block starts at ${clock(Date.parse(nextScheduledAt))}.`,
    };
  return { ok: true, seconds: Math.floor(offsetMs / 1000) };
}
