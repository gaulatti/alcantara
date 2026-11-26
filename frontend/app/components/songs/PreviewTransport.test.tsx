import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Transport } from "./PreviewTransport";

afterEach(cleanup);

function setup(overrides: Partial<React.ComponentProps<typeof Transport>> = {}) {
  const props = {
    title: "Artist - Title",
    subtitle: "Local preview",
    position: 72,
    duration: 214,
    playing: false,
    onToggle: vi.fn(),
    onSeek: vi.fn(),
    onPrev: vi.fn(),
    onNext: vi.fn(),
    ...overrides,
  };
  render(<Transport {...props} />);
  return props;
}

it("shows what is loaded and the time, and its buttons act", () => {
  const props = setup({ cues: [{ at: 0.4, label: "In" }] });
  expect(screen.getByText("Artist - Title")).toBeInTheDocument();
  expect(screen.getByText("1:12")).toBeInTheDocument();
  expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "1:12 of 3:34");
  expect(screen.getByTitle("In")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(props.onToggle).toHaveBeenCalledOnce();
  expect(props.onPrev).toHaveBeenCalledOnce();
  expect(props.onNext).toHaveBeenCalledOnce();
});

it("shows Pause while playing, and seeks within the length with the arrow keys and Space toggles", () => {
  const props = setup({ playing: true, position: 212 });
  expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  const slider = screen.getByRole("slider");
  fireEvent.keyDown(slider, { key: "ArrowRight" });
  expect(props.onSeek).toHaveBeenLastCalledWith(214);
  fireEvent.keyDown(slider, { key: "ArrowLeft" });
  expect(props.onSeek).toHaveBeenLastCalledWith(207);
  fireEvent.keyDown(slider, { key: " " });
  expect(props.onToggle).toHaveBeenCalledOnce();
  fireEvent.keyDown(slider, { key: "x" });
  expect(props.onSeek).toHaveBeenCalledTimes(2);
});

it("seeks to a clicked place on the timeline, but not when disabled", () => {
  const props = setup();
  const slider = screen.getByRole("slider");
  slider.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 10, right: 200, bottom: 10, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.click(slider, { clientX: 100 });
  expect(props.onSeek).toHaveBeenCalledWith(107);
  cleanup();
  const off = setup({ disabled: true });
  const disabledSlider = screen.getByRole("slider");
  disabledSlider.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 10, right: 200, bottom: 10, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.click(disabledSlider, { clientX: 100 });
  expect(off.onSeek).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
});

it("has no timeline when the length is unknown, and nothing to step to without handlers", () => {
  setup({ duration: null, position: 5, onPrev: undefined, onNext: undefined, subtitle: undefined });
  expect(screen.queryByRole("slider")).toBeNull();
  expect(screen.getByText("0:05")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
});

it("ignores the arrow keys on a timeline that has no seek handler", () => {
  setup({ playing: false, position: 30, onSeek: undefined });
  const slider = screen.getByRole("slider");
  expect(() => fireEvent.keyDown(slider, { key: "ArrowRight" })).not.toThrow();
  expect(slider).toBeInTheDocument();
});
