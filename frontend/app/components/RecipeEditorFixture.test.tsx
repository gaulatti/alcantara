import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RecipeEditorFixture } from "./RecipeEditorFixture";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("renders the recipe, its two uses and the preview with its issue, without a request", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  render(<RecipeEditorFixture />);
  expect(screen.getByText("Revision 4 · 2 uses")).toBeTruthy();
  const steps = screen.getByRole("list", { name: "Preview steps" });
  expect(within(steps).getAllByRole("listitem")).toHaveLength(8);
  expect(screen.getByText("artist_label_missing")).toBeTruthy();
  expect(screen.getByLabelText("Bumper scene")).toHaveTextContent("Artist bumper");
  expect(fetchMock).not.toHaveBeenCalled();
});
