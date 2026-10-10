import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ScenePreparationFixture } from "./ScenePreparationFixture";

afterEach(cleanup);

it("renders the actual clock editor with dedicated checkboxes and one component label", () => {
  render(<ScenePreparationFixture clock />);
  expect(screen.getAllByText("Modo Italiano Clock")).toHaveLength(1);
  const panel = screen.getByRole("tabpanel", { name: "Modo Italiano Clock" });
  const control = within(panel).getByRole("checkbox", {
    name: "Show World Clocks",
  });
  expect(control).toBeChecked();
  // Bleecker Checkbox owns a fixed-size shell; Input owns a full-width text shell.
  expect(control.parentElement).toHaveClass("shrink-0", "w-5");
  expect(control.parentElement).not.toHaveClass("w-full");
  fireEvent.click(control);
  expect(control).not.toBeChecked();
  const footer = screen.getByRole("button", { name: "Save changes" });
  expect(panel).not.toContainElement(footer);
  expect(
    screen.getByText("This scene is on Program. Saved changes appear live."),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Slideshow" }));
  const slide = screen.getByRole("tabpanel", { name: "Slideshow" });
  fireEvent.click(within(slide).getByRole("checkbox", { name: "Shuffle" }));
  expect(
    within(slide).getByRole("checkbox", { name: "Shuffle" }),
  ).toBeChecked();
  fireEvent.click(screen.getByRole("tab", { name: "Modo Italiano Clock" }));
  expect(
    screen.getByRole("checkbox", { name: "Show World Clocks" }),
  ).not.toBeChecked();
});

it("keeps hidden restoration scoped to its tab and exposes correctly associated player fields", () => {
  render(<ScenePreparationFixture clock />);
  expect(screen.queryByRole("button", { name: "Show component" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Giorgia player" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Giorgia player is hidden.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Show component" }));
  expect(screen.queryByText("Giorgia player is hidden.")).toBeNull();
  expect(screen.getByRole("checkbox", { name: "Show Player" })).toBeChecked();
  const title = screen.getByRole("textbox", { name: "Episode Title" });
  fireEvent.change(title, { target: { value: "Rehearsal two" } });
  expect(title).toHaveValue("Rehearsal two");
});

it("keeps save errors visible and disables Save while a request is pending", () => {
  const { rerender } = render(<ScenePreparationFixture clock error />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Changes could not be saved",
  );
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  rerender(<ScenePreparationFixture clock saving />);
  expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
});
