import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MediaFixture from "./media-fixture";

// gaulatti/alcantara#624: the media fixture's inline label creator, used the way a reviewer uses it. Fictional names only.

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("accepts a new label name in the inline creator", async () => {
  render(
    <MemoryRouter>
      <MediaFixture />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText("New label name"), { target: { value: "Fictional jingles" } });
  const create = screen.getAllByRole("button").find((button) => /create|add/i.test(button.textContent ?? ""));
  expect(create).toBeDefined();
  fireEvent.click(create!);
  await waitFor(() => expect(screen.getByLabelText("New label name")).toHaveValue(""));
});
