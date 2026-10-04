import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RundownFixture } from "./RundownFixture";
import { rundownFixtureLog } from "./RundownFixture";
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => ["radio-demo"],
}));
beforeEach(() => vi.stubGlobal("matchMedia", () => ({ matches: false })));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("keeps the hour readable while editing only the selected event", async () => {
  render(<RundownFixture />);
  const table = await screen.findByRole("table", {
    name: "Scheduled rundown events",
  });
  expect(within(table).getAllByRole("button")).toHaveLength(
    rundownFixtureLog.items.length,
  );
  expect(within(table).queryByRole("combobox")).not.toBeInTheDocument();
  fireEvent.click(within(table).getAllByRole("button")[0]);
  expect(
    screen.getByRole("spinbutton", { name: "Fixed start" }),
  ).toBeDisabled();
  fireEvent.change(screen.getByRole("spinbutton", { name: "Clip duration" }), {
    target: { value: "120" },
  });
  expect(within(table).getAllByRole("row")[1]).toHaveTextContent("02:00");
  expect(screen.getByText(/Unsaved changes/)).toBeVisible();
  expect(
    screen.getByRole("combobox", { name: "Scheduled hour" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(within(table).getAllByRole("row")[1]).toHaveTextContent("03:00");
});
it("inserts new content before the fixed end of hour", async () => {
  render(<RundownFixture />);
  const table = await screen.findByRole("table", {
    name: "Scheduled rundown events",
  });
  fireEvent.click(screen.getByRole("button", { name: "Clip" }));
  const rows = within(table).getAllByRole("button");
  expect(rows.at(-2)).toHaveTextContent("News bulletin");
  expect(rows.at(-1)).toHaveTextContent("End of hour");
  expect(
    screen.getByRole("spinbutton", { name: "Clip duration" }),
  ).toBeVisible();
  expect(within(table).getByText("Unknown")).toBeVisible();
  expect(screen.getByText(/1 unknown durations/)).toBeVisible();
});
