import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CallerDeskFixture, ProgramReturnFixture } from "./ReturnCallersFixture";

// gaulatti/alcantara#624: the fixture's own timer and the caller desk's no-op callbacks, which only run when
// a reviewer uses the controls. Names are fictional.

vi.mock("@gaulatti/bleecker", async (original) => {
  const actual = await original<typeof import("@gaulatti/bleecker")>();
  return {
    ...actual,
    Select: ({ options, onChange, value, ...props }: { options: { value: string; label: string }[]; onChange: (v: string) => void; value: string }) => (
      <select {...props} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("moves the program return clock every half second", () => {
  const { unmount } = render(<ProgramReturnFixture />);
  act(() => {
    vi.advanceTimersByTime(500);
  });
  expect(screen.getAllByText("Live").length).toBeGreaterThan(0);
  unmount();
});

it("runs every caller desk control on the fixture", () => {
  render(<CallerDeskFixture />);
  fireEvent.change(screen.getByLabelText("Message Lucía Ferrer"), { target: { value: "Stand by" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Standby" })[0]);
  fireEvent.click(screen.getAllByRole("button", { name: "Routed to returns" })[0]);
  // The second guest is connected and not cued live, so talk is enabled for it.
  const talk = screen.getAllByRole("button", { name: "Hold · talk (T)" })[1];
  fireEvent.pointerDown(talk);
  fireEvent.pointerUp(talk);
  fireEvent.click(screen.getAllByRole("button", { name: "Replace link" })[0]);
  fireEvent.click(screen.getAllByRole("button", { name: "Remove session" })[0]);
  fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0]);
  expect(screen.getAllByRole("article").length).toBeGreaterThan(0);
});
