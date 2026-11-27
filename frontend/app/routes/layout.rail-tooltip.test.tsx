import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { renderRailLink } from "./layout";

// gaulatti/alcantara#688, item 1: the collapsed rail shows icons only, so each link's label opens as a
// tooltip on keyboard focus (and hover); a link with no label gets no tooltip trigger. Fictional labels only.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function rail(label?: string) {
  return render(
    <MemoryRouter>
      {renderRailLink({
        item: { href: "/radio", label, active: true },
        className: "rail-link",
        children: <svg aria-hidden="true" />,
      })}
    </MemoryRouter>,
  );
}

it("shows the label beside an icon-only rail link on keyboard focus, keeping its accessible name", () => {
  // jsdom has no ResizeObserver; Radix measures the open tooltip with one.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const view = rail("Radio desk");
  const link = screen.getByRole("link", { name: "Radio desk" });
  expect(link).toHaveAttribute("href", "/radio");
  expect(link).toHaveAttribute("aria-current", "page");
  expect(document.querySelector("[role=tooltip]")).toBeNull();
  act(() => {
    fireEvent.focus(link);
  });
  const tooltip = document.querySelector("[role=tooltip]")!;
  expect(tooltip.textContent).toBe("Radio desk");
  expect(link).toHaveAttribute("aria-describedby", tooltip.id);
  act(() => {
    fireEvent.blur(link);
  });
  view.unmount();
});

it("adds no tooltip to a link without a label", () => {
  render(
    <MemoryRouter>
      {renderRailLink({
        item: { href: "/radio", active: false },
        className: "rail-link",
        children: <svg aria-hidden="true" />,
      })}
    </MemoryRouter>,
  );
  const link = screen.getByRole("link");
  expect(link).not.toHaveAttribute("data-state");
});
