import { useEffect, useRef } from "react";
import { cellKey, type DaypartCells } from "../utils/daypartCells";

/** Monday first; values are the API's days, where 0 is Sunday. */
const DAYS = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [0, "Sun"],
] as const;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const hourText = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

/** The week as hours by days. Pressing an hour paints it; dragging paints every hour passed over. */
export function DaypartGrid({
  cells,
  clocks,
  colorOf,
  onPaint,
}: {
  cells: DaypartCells;
  clocks: { id: number; name: string }[];
  colorOf: (clockId: number) => string;
  onPaint: (key: string) => void;
}) {
  const painting = useRef(false);
  useEffect(() => {
    const stop = () => {
      painting.current = false;
    };
    window.addEventListener("pointerup", stop);
    return () => window.removeEventListener("pointerup", stop);
  }, []);
  return (
    <div className="overflow-x-auto">
      <table
        className="w-full table-fixed border-collapse select-none text-xs"
        aria-label="Weekly dayparts"
      >
        <thead>
          <tr>
            <th className="w-12" aria-label="Hour" />
            {DAYS.map(([day, label]) => (
              <th key={day} scope="col" className="pb-1 font-semibold">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {HOURS.map((hour) => (
            <tr key={hour}>
              <th
                scope="row"
                className="pr-2 text-right font-normal text-text-secondary"
              >
                {hourText(hour)}
              </th>
              {DAYS.map(([day, label]) => {
                const key = cellKey(day, hour);
                const cell = cells[key];
                const name = clocks.find(
                  (clock) => clock.id === cell?.clockId,
                )?.name;
                const text = `${label} ${hourText(hour)}${
                  name
                    ? `, ${name}${cell.start === "hard" ? ", hard start" : ""}`
                    : ", no clock"
                }`;
                return (
                  <td key={day} className="border border-border-subtle p-0">
                    <button
                      type="button"
                      aria-label={text}
                      title={text}
                      className={`block h-5 w-full touch-none ${
                        cell ? colorOf(cell.clockId) : "hover:bg-sand/10"
                      } ${cell?.start === "hard" ? "border-t-2 border-white" : ""}`}
                      onPointerDown={(event) => {
                        event.currentTarget.releasePointerCapture?.(
                          event.pointerId,
                        );
                        painting.current = true;
                        onPaint(key);
                      }}
                      onPointerEnter={() => {
                        if (painting.current) onPaint(key);
                      }}
                      // A keyboard press; a pointer's click was painted on the way down.
                      onClick={(event) => {
                        if (event.detail === 0) onPaint(key);
                      }}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
