import type { RadioDaypart } from "../services/dayparts";

/** One painted hour of the week. */
export type DaypartCell = Pick<RadioDaypart, "clockId" | "start">;
/** Painted hours by `day-hour`; an hour with no entry has no clock. */
export type DaypartCells = Record<string, DaypartCell>;

export const cellKey = (dayOfWeek: number, hour: number) =>
  `${dayOfWeek}-${hour}`;

export function cellsOf(dayparts: RadioDaypart[]): DaypartCells {
  const cells: DaypartCells = {};
  for (const daypart of dayparts)
    for (let hour = daypart.startHour; hour < daypart.endHour; hour++)
      cells[cellKey(daypart.dayOfWeek, hour)] = {
        clockId: daypart.clockId,
        start: daypart.start,
      };
  return cells;
}

/** The painted hours as dayparts: neighbouring hours with the same clock and start become one. */
export function daypartsFrom(cells: DaypartCells): RadioDaypart[] {
  const dayparts: RadioDaypart[] = [];
  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++)
    for (let hour = 0; hour < 24; hour++) {
      const cell = cells[cellKey(dayOfWeek, hour)];
      if (!cell) continue;
      const last = dayparts.at(-1);
      if (
        last &&
        last.dayOfWeek === dayOfWeek &&
        last.endHour === hour &&
        last.clockId === cell.clockId &&
        last.start === cell.start
      )
        last.endHour = hour + 1;
      else
        dayparts.push({
          dayOfWeek,
          startHour: hour,
          endHour: hour + 1,
          ...cell,
        });
    }
  return dayparts;
}
