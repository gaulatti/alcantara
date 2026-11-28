/** gaulatti/alcantara#124: the whole hours of a time zone that begin inside a window. */
export interface DaypartHour {
  at: Date;
  /** 0 = Sunday, in the zone. */
  dayOfWeek: number;
  hour: number;
  /** "2026-03-29 02:00 +02:00": unique even when a clock change repeats an hour. */
  label: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Every zone's offset is a multiple of this, so every local hour begins on one. */
const STEP_MS = 15 * 60_000;

export function hoursStartingWithin(
  fromMs: number,
  toMs: number,
  timeZone: string,
): DaypartHour[] {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'longOffset',
  });
  const hours: DaypartHour[] = [];
  for (
    let ms = Math.floor(fromMs / STEP_MS) * STEP_MS + STEP_MS;
    ms <= toMs;
    ms += STEP_MS
  ) {
    const parts = Object.fromEntries(
      format.formatToParts(ms).map((part) => [part.type, part.value]),
    );
    if (parts.minute !== '00') continue;
    const offset = parts.timeZoneName.replace('GMT', '') || '+00:00';
    hours.push({
      at: new Date(ms),
      dayOfWeek: WEEKDAYS.indexOf(parts.weekday),
      hour: Number(parts.hour),
      label: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:00 ${offset}`,
    });
  }
  return hours;
}
