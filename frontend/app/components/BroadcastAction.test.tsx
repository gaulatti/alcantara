import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Tooltip } from "@gaulatti/bleecker/components/tooltip";
import { BroadcastAction } from "./BroadcastAction";

// gaulatti/alcantara#404 (broadcast actions, from the full-run table): the take and cut buttons explain what
// they do to the Preview and Program scenes; the other kinds carry no explanation of their own, and a
// full-width action fills its row.

vi.mock("@gaulatti/bleecker/components/tooltip", () => ({
  Tooltip: vi.fn(({ children }: { children: ReactNode }) => children),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const explanation = () => vi.mocked(Tooltip).mock.calls.at(-1)?.[0].content;

it("explains a take as a transition of Preview to Program", () => {
  render(<BroadcastAction kind="take">Take</BroadcastAction>);
  expect(explanation()).toBe("Transition Preview to Program and move the previous Program scene to Preview");
});

it("explains a cut as a cut of Preview to Program", () => {
  render(<BroadcastAction kind="cut">Cut</BroadcastAction>);
  expect(explanation()).toBe("Cut Preview to Program and move the previous Program scene to Preview");
});

it("adds no explanation to a danger or a restore action", () => {
  vi.mocked(Tooltip).mockClear();
  render(
    <>
      <BroadcastAction kind="danger">Stop</BroadcastAction>
      <BroadcastAction kind="restore">Restore</BroadcastAction>
    </>,
  );
  // Their only explanation is their own label, never a Preview or Program description.
  expect(vi.mocked(Tooltip).mock.calls.map(([props]) => props.content)).toEqual(["Stop", "Restore"]);
  expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
});

it("fills its row when it is full width, and keeps the caller's own class", () => {
  render(
    <BroadcastAction kind="cut" fullWidth className="my-row">
      Cut
    </BroadcastAction>,
  );
  const button = screen.getByRole("button", { name: "Cut" });
  expect(button).toHaveClass("w-full", "my-row");
});
