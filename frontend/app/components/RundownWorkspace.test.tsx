import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { RundownWorkspace } from "./RundownWorkspace";
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => ["fixture"],
}));
vi.mock("./ScheduledRundown", () => ({
  default: ({
    onDirtyChange,
  }: {
    onDirtyChange?: (dirty: boolean) => void;
  }) => (
    <>
      <h1>Scheduled rundown</h1>
      <button onClick={() => onDirtyChange?.(true)}>Edit draft</button>
      <button onClick={() => onDirtyChange?.(false)}>Save draft</button>
    </>
  ),
}));
vi.mock("./ManualRundown", () => ({
  default: () => <h1>Operator rundown</h1>,
}));
afterEach(cleanup);
it("opens scheduled radio and operator TV controls at the same workspace", async () => {
  const view = render(
    <MemoryRouter>
      <RundownWorkspace programType="radio" />
    </MemoryRouter>,
  );
  expect(await screen.findByText("Scheduled rundown")).toBeVisible();
  view.rerender(
    <MemoryRouter>
      <RundownWorkspace programType="tv" />
    </MemoryRouter>,
  );
  expect(await screen.findByText("Operator rundown")).toBeVisible();
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
});
it("keeps unsaved filler previews in the scheduled view until saved", async () => {
  render(
    <MemoryRouter>
      <RundownWorkspace programType="both" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Edit draft" }));
  expect(screen.getByRole("button", { name: "Operator cues" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Operator cues" }));
  expect(screen.getByText("Scheduled rundown")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  fireEvent.click(screen.getByRole("button", { name: "Operator cues" }));
  expect(await screen.findByText("Operator rundown")).toBeVisible();
});
it("gives simulcast timing views within one Rundown", async () => {
  render(
    <MemoryRouter>
      <RundownWorkspace programType="both" />
    </MemoryRouter>,
  );
  expect(await screen.findByText("Scheduled rundown")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Operator cues" }));
  expect(await screen.findByText("Operator rundown")).toBeVisible();
  expect(screen.getByRole("button", { name: "Operator cues" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
