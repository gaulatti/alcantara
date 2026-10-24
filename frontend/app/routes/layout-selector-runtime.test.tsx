import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { mount, writes } from "../../test/layoutRuntimeFixture";
// Keep the real Radix pointer lifecycle isolated from command/modal workflows.
// Advance the actual preference debounce deterministically after selection.
it("changes the active program using the real accessible header selector", async () => {
  await mount("/");
  await waitFor(() =>
    expect(
      localStorage.getItem("alcantara.console.acknowledged.operator-a.desktop"),
    ).not.toBeNull(),
  );
  vi.useFakeTimers();
  try {
    const selector = screen.getAllByRole("combobox", { name: "Program" })[0];
    fireEvent.pointerDown(selector, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
      clientX: 10,
      clientY: 10,
    });
    const option = screen.getByRole("option", { name: "radio" });
    fireEvent.pointerMove(option, {
      pointerType: "mouse",
      clientX: 20,
      clientY: 100,
    });
    fireEvent.pointerDown(option, {
      pointerType: "mouse",
      clientX: 20,
      clientY: 100,
    });
    fireEvent.pointerUp(option, {
      pointerType: "mouse",
      clientX: 20,
      clientY: 100,
    });
    expect(screen.getByTestId("program-type")).toHaveTextContent("radio");
    expect(selector).toHaveAttribute("aria-expanded", "false");
    act(() => {
      vi.advanceTimersByTime(750);
    });
    expect(writes("/operator-preferences/desktop")).toHaveLength(1);
    expect(
      writes("/operator-preferences/desktop")[0].body.profile.selectedProgramId,
    ).toBe("radio");
  } finally {
    vi.useRealTimers();
  }
});
