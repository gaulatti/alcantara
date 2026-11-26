import { createPortal } from "react-dom"; import { createRef, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Button, IconButton } from "@gaulatti/bleecker";
import { Tooltip } from "@gaulatti/bleecker/components/tooltip";
import { Button as AppButton, TooltipButton } from "./BleeckerButtons";

// Verify the application-to-Bleecker contract. Popper positioning and hover/focus
// visuals require a browser and are exposed in the button-help visual fixture.
vi.mock("@gaulatti/bleecker/components/tooltip", () => ({
  Tooltip: vi.fn(({ children }: { children: ReactNode }) => children),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function help() {
  return vi.mocked(Tooltip).mock.calls.at(-1)?.[0].content;
}

it("passes explicit help to Bleecker while preserving the name, ref, direct child and action", () => {
  const ref = createRef<HTMLButtonElement>();
  const onClick = vi.fn();
  const { container } = render(
    <Button
      ref={ref}
      title="Save this scene for the next TAKE"
      onClick={onClick}
    >
      <span>Save scene</span>
    </Button>,
  );
  const button = screen.getByRole("button", { name: "Save scene" });
  expect(help()).toBe("Save this scene for the next TAKE");
  expect(ref.current).toBe(button);
  expect(button.parentElement).toBe(container);
  expect(button).not.toHaveAttribute("title");
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledTimes(1);
});
it("uses accessible action labels and preserves title-only icon names", () => {
  const { rerender } = render(
    <IconButton aria-label="Open Media library">
      <svg aria-hidden="true" />
    </IconButton>,
  );
  expect(help()).toBe("Open Media library");
  rerender(
    <IconButton title="Refresh program state">
      <svg aria-hidden="true" />
    </IconButton>,
  );
  expect(
    screen.getByRole("button", { name: "Refresh program state" }),
  ).toBeInTheDocument();
  expect(help()).toBe("Refresh program state");
});
it("uses visible action text and retains Bleecker link behavior", () => {
  render(
    <Button as="a" href="/media">
      <span>Add</span> <span>songs</span>
    </Button>,
  );
  expect(help()).toBe("Add songs");
  expect(screen.getByRole("link", { name: "Add songs" })).toHaveAttribute(
    "href",
    "/media",
  );
});
it("keeps disabled controls inert while passing their explanation and allowing pointer help", () => {
  const onClick = vi.fn();
  render(
    <TooltipButton
      disabled
      title="Stage a scene before TAKE"
      className="switcher-take"
      onClick={onClick}
    >
      TAKE
    </TooltipButton>,
  );
  const button = screen.getByRole("button", { name: "TAKE" });
  expect(help()).toBe("Stage a scene before TAKE");
  expect(button).toBeDisabled();
  expect(button).toHaveClass("switcher-take");
  expect(button).toHaveStyle({ pointerEvents: "auto" });
  fireEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
});

it("labels a button from nested text and ignores non-text children", () => {
  const { rerender } = render(
    <TooltipButton>
      <span>
        <b>Start</b> <i>now</i>
      </span>
      {null}
      {false}
    </TooltipButton>,
  );
  expect(help()).toBe("Start now");
  expect(screen.getByRole("button", { name: "Start now" })).toBeInTheDocument();
  rerender(
    <Button>
      <span>
        <b>Start</b> <i>now</i>
      </span>
    </Button>,
  );
  expect(help()).toBe("Start now");
});

it("adds no help when a control has no name, title or label of its own", () => {
  vi.mocked(Tooltip).mockClear();
  const { container } = render(
    <>
      <Button>
        <svg aria-hidden="true" />
      </Button>
      <IconButton>
        <svg aria-hidden="true" />
      </IconButton>
      <TooltipButton>
        <svg aria-hidden="true" />
      </TooltipButton>
    </>,
  );
  expect(Tooltip).not.toHaveBeenCalled();
  expect(container.querySelectorAll("button")).toHaveLength(3);
});

it("labels a button from its text when a child is a portal, not an element", () => {
  render(
    <TooltipButton>
      {createPortal(<i>hidden</i>, document.body)}
      Go
    </TooltipButton>,
  );
  expect(help()).toBe("Go");
  expect(screen.getByRole("button", { name: "Go" })).toBeInTheDocument();
});
// The walk's polish: a button just under a field opens its help below, off the field.
it("opens the help on the side asked for, and keeps the side off the button", () => {
  render(
    <>
      <AppButton tooltipSide="bottom">Remove</AppButton>
      <AppButton>Record voice</AppButton>
    </>,
  );
  const calls = vi.mocked(Tooltip).mock.calls.map(([props]) => props);
  expect(calls.find((props) => props.content === "Remove")?.side).toBe("bottom");
  expect(calls.find((props) => props.content === "Record voice")?.side).toBeUndefined();
  expect(screen.getByRole("button", { name: "Remove" })).not.toHaveAttribute("tooltipside");
});
