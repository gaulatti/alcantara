import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RecordingFixture from "./recording-fixture";

// gaulatti/alcantara#624: each recording state's enabled controls, clicked as a reviewer would. Fictional names only.

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each(["disabled", "idle", "requested", "active", "finalizing", "complete", "failed"])(
  "accepts a click on every enabled recording control in the %s state",
  (state) => {
    render(
      <MemoryRouter initialEntries={[`/recording-fixture?state=${state}`]}>
        <RecordingFixture />
      </MemoryRouter>,
    );
    for (const button of screen.queryAllByRole("button").filter((b) => !(b as HTMLButtonElement).disabled)) {
      fireEvent.click(button);
    }
    expect(screen.getByRole("heading", { name: "Program recording" })).toBeInTheDocument();
    cleanup();
  },
);
