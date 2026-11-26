import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it } from "vitest";
import { renderRailLink } from "./layout";

// #688, item 1: a rail link with no label gets no tooltip trigger (the opened tooltip is in layout.rail-tooltip.test.tsx,
// alone in its file as tooltip-isolation.test.ts asks).
afterEach(cleanup);

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
