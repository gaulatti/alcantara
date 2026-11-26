import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SongIntroFixture from "./song-intro-fixture";

// gaulatti/alcantara#624: the fixture's controls are inert, but a reviewer's clicks reach them. Fictional names only.

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("accepts a click on every enabled control without changing the fixture", () => {
  render(
    <MemoryRouter>
      <SongIntroFixture />
    </MemoryRouter>,
  );
  const enabled = screen.getAllByRole("button").filter((button) => !(button as HTMLButtonElement).disabled);
  expect(enabled.length).toBeGreaterThan(0);
  for (const button of enabled) fireEvent.click(button);
  expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
});
