import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DaypartsRoute, { daypartBlocks, meta } from "./dayparts";
import { cellsOf, daypartsFrom } from "../utils/daypartCells";
import * as dayparts from "../services/dayparts";
import * as flight from "../services/flight";
import * as labels from "../services/mediaLabels";

// gaulatti/alcantara#124: the weekly grid of clocks.
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => ["night radio"],
}));
vi.mock("@gaulatti/bleecker", async (original) => {
  const kit = await import("../../test/routeKit");
  return kit.nativeSelect(
    original as () => Promise<typeof import("@gaulatti/bleecker")>,
  );
});

const clock = {
  id: 5,
  name: "Fictional morning",
  rules: { artistSeparation: 2, slots: [{ labelId: "t1", count: 3 }] },
  revision: 1,
};
const NOW = Date.parse("2026-12-07T05:30:00Z");
const block = (id: number, offsetHours: number, outcome: string | null) =>
  ({
    id,
    name: `Fictional block ${id}`,
    scheduledAt: new Date(Date.now() + offsetHours * 3_600_000).toISOString(),
    daypart: { clockId: 5, start: "soft", outcome },
  }) as never;

beforeEach(() => {
  vi.spyOn(dayparts, "fetchRadioClocks").mockResolvedValue([clock]);
  vi.spyOn(dayparts, "fetchRadioDayparts").mockResolvedValue({
    timeZone: null,
    revision: 0,
    dayparts: [],
  });
  vi.spyOn(dayparts, "saveRadioDayparts").mockImplementation(
    async (_program, grid) => ({ ...grid, revision: grid.revision + 1 }),
  );
  vi.spyOn(dayparts, "createRadioClock").mockResolvedValue({
    ...clock,
    id: 6,
  });
  vi.spyOn(dayparts, "updateRadioClock").mockResolvedValue(clock);
  vi.spyOn(dayparts, "deleteRadioClock").mockResolvedValue({ deleted: true });
  vi.spyOn(flight, "fetchFlightSequences").mockResolvedValue([]);
  vi.spyOn(labels, "fetchAllMediaLabels").mockResolvedValue([
    { id: "t1", name: "Fictional tag" },
  ] as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const open = async () => {
  render(
    <MemoryRouter>
      <DaypartsRoute />
    </MemoryRouter>,
  );
  await screen.findByRole("table", { name: "Weekly dayparts" });
};
const hour = (name: RegExp) => screen.getByRole("button", { name });
const pick = (name: string, value: string) =>
  fireEvent.change(screen.getByRole("combobox", { name }), {
    target: { value },
  });

it("paints hours with a clock, by press, drag or keyboard, and saves them as dayparts", async () => {
  expect(meta()[0]).toEqual({ title: "Dayparts - Alcantara" });
  await open();
  const save = screen.getByRole("button", { name: "Save grid" });
  expect(save).toBeDisabled();

  pick("Paint with", "5");
  fireEvent.pointerDown(hour(/^Mon 06:00/));
  fireEvent.pointerEnter(hour(/^Mon 07:00/));
  fireEvent.pointerUp(window);
  fireEvent.pointerEnter(hour(/^Mon 08:00/));
  pick("Starts", "hard");
  // A keyboard press paints; the click that ends a pointer press does not paint again.
  fireEvent.click(hour(/^Sun 23:00/), { detail: 0 });
  fireEvent.click(hour(/^Sun 22:00/), { detail: 1 });
  expect(hour(/^Sun 23:00/)).toHaveAccessibleName(
    "Sun 23:00, Fictional morning, hard start",
  );
  expect(hour(/^Mon 08:00/)).toHaveAccessibleName("Mon 08:00, no clock");
  pick("Paint with", "");
  fireEvent.pointerDown(hour(/^Mon 07:00/));
  fireEvent.change(screen.getByRole("textbox", { name: "Time zone" }), {
    target: { value: "Europe/Rome" },
  });
  fireEvent.click(save);
  await waitFor(() => expect(save).toBeDisabled());
  expect(dayparts.saveRadioDayparts).toHaveBeenCalledWith("night radio", {
    timeZone: "Europe/Rome",
    revision: 0,
    dayparts: [
      { dayOfWeek: 0, startHour: 23, endHour: 24, clockId: 5, start: "hard" },
      { dayOfWeek: 1, startHour: 6, endHour: 7, clockId: 5, start: "soft" },
    ],
  });
  // A changed zone alone is a change once a grid is saved.
  fireEvent.change(screen.getByRole("textbox", { name: "Time zone" }), {
    target: { value: "UTC" },
  });
  expect(save).toBeEnabled();
});

it("creates, changes and deletes a clock with its tagged blocks", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Clock" }));
  const saveClock = screen.getByRole("button", { name: "Save clock" });
  expect(saveClock).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: "Clock name" }), {
    target: { value: " Evening " },
  });
  pick("Tag for block 1", "t1");
  fireEvent.click(saveClock);
  await waitFor(() =>
    expect(dayparts.createRadioClock).toHaveBeenCalledWith("night radio", {
      name: "Evening",
      rules: {
        artistSeparation: 2,
        slots: [{ labelId: "t1", count: 1, clockOffsetSeconds: 0 }],
      },
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: "Fictional morning" }));
  fireEvent.click(screen.getByRole("button", { name: "Save clock" }));
  await waitFor(() =>
    expect(dayparts.updateRadioClock).toHaveBeenCalledWith("night radio", 5, {
      name: clock.name,
      rules: clock.rules,
      revision: 1,
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Delete clock" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete clock" }));
  await waitFor(() =>
    expect(dayparts.deleteRadioClock).toHaveBeenCalledWith("night radio", 5, 1),
  );
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Clock name" })).toBeNull(),
  );
});

it("shows why a save or the first load failed", async () => {
  vi.mocked(dayparts.saveRadioDayparts).mockRejectedValue(
    new Error("The grid changed. Reload before saving."),
  );
  await open();
  pick("Paint with", "5");
  fireEvent.pointerDown(hour(/^Tue 01:00/));
  fireEvent.click(screen.getByRole("button", { name: "Save grid" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The grid changed",
  );
  cleanup();

  vi.mocked(dayparts.fetchRadioDayparts).mockRejectedValue("no");
  vi.mocked(flight.fetchFlightSequences).mockRejectedValue(new Error("no"));
  render(
    <MemoryRouter>
      <DaypartsRoute />
    </MemoryRouter>,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Dayparts unavailable",
  );
});

it("lists the next two blocks and marks a skipped or failed hour with a dot", async () => {
  vi.mocked(dayparts.fetchRadioDayparts).mockResolvedValue({
    timeZone: "UTC",
    revision: 3,
    dayparts: [
      { dayOfWeek: 1, startHour: 6, endHour: 8, clockId: 5, start: "soft" },
    ],
  });
  vi.mocked(flight.fetchFlightSequences).mockResolvedValue([
    block(3, 2, null),
    block(1, -1, "skipped"),
    block(2, 1, "failed"),
    block(4, 3, null),
    block(5, -48, "failed"),
    { id: 6, name: "Hand made", scheduledAt: null } as never,
  ]);
  await open();
  await screen.findByText("Fictional block 2");
  expect(
    screen.getAllByRole("link").map((link) => link.textContent),
  ).toEqual(["Fictional block 1", "Fictional block 2", "Fictional block 3"]);
  expect(screen.getByRole("img", { name: "Skipped" })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Failed" })).toBeInTheDocument();
  expect(daypartBlocks([], NOW)).toEqual([]);
  expect(hour(/^Mon 07:00/)).toHaveAccessibleName(
    "Mon 07:00, Fictional morning",
  );
});

it("turns painted hours into dayparts and back", () => {
  const grid = [
    { dayOfWeek: 1, startHour: 6, endHour: 9, clockId: 5, start: "soft" },
    { dayOfWeek: 1, startHour: 9, endHour: 10, clockId: 6, start: "soft" },
    { dayOfWeek: 2, startHour: 10, endHour: 11, clockId: 6, start: "soft" },
  ] as const;
  expect(daypartsFrom(cellsOf([...grid]))).toEqual(grid);
});
