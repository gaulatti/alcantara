import { apiUrl } from "../utils/apiBaseUrl";
import type { RadioLogRules } from "./flight";

export interface RadioClock {
  id: number;
  name: string;
  rules: RadioLogRules;
  revision: number;
}

export interface RadioDaypart {
  /** 0 = Sunday. */
  dayOfWeek: number;
  startHour: number;
  endHour: number;
  clockId: number;
  start: "soft" | "hard";
}

export interface RadioDaypartGrid {
  timeZone: string | null;
  revision: number;
  dayparts: RadioDaypart[];
}

async function request<T>(
  programId: string,
  path: string,
  init?: { method: string; body?: unknown },
): Promise<T> {
  const url = apiUrl(`/program/${encodeURIComponent(programId)}/${path}`);
  const response = await (init
    ? fetch(url, {
        method: init.method,
        headers: { "Content-Type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
    : fetch(url));
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(
      typeof body?.message === "string"
        ? body.message
        : `Dayparts request failed (${response.status})`,
    );
  }
  return response.json();
}

export const fetchRadioClocks = (programId: string) =>
  request<RadioClock[]>(programId, "radio-clocks");

export const createRadioClock = (
  programId: string,
  clock: { name: string; rules: RadioLogRules },
) =>
  request<RadioClock>(programId, "radio-clocks", {
    method: "POST",
    body: clock,
  });

export const updateRadioClock = (
  programId: string,
  clockId: number,
  clock: { name: string; rules: RadioLogRules; revision: number },
) =>
  request<RadioClock>(programId, `radio-clocks/${clockId}`, {
    method: "PUT",
    body: clock,
  });

export const deleteRadioClock = (
  programId: string,
  clockId: number,
  revision: number,
) =>
  request<{ deleted: true }>(
    programId,
    `radio-clocks/${clockId}?revision=${revision}`,
    { method: "DELETE" },
  );

export const fetchRadioDayparts = (programId: string) =>
  request<RadioDaypartGrid>(programId, "radio-dayparts");

export const saveRadioDayparts = (
  programId: string,
  grid: { timeZone: string; revision: number; dayparts: RadioDaypart[] },
) =>
  request<RadioDaypartGrid>(programId, "radio-dayparts", {
    method: "PUT",
    body: grid,
  });
