import { Sidebar } from "@gaulatti/bleecker";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { sidebarSectionsKey } from "./appNavigation";

// alcantara#875: on TV destinations the sidebar showed no item at all. Its section's active item arrives with the
// operator's permissions, after the sidebar had already decided that nothing in the section was open.
afterEach(cleanup);

const live = (withDestinations: boolean) => [
  {
    id: "live",
    label: "Live",
    active: withDestinations,
    items: [
      { id: "control", href: "/", label: "TV control" },
      ...(withDestinations ? [{ id: "destinations", href: "/broadcasts", label: "TV destinations", active: true }] : []),
    ],
  },
];

it("opens the section of the page on screen when its item arrives after the sidebar mounted", () => {
  const draw = (items: ReturnType<typeof live>) => <Sidebar key={sidebarSectionsKey(items)} items={items} />;
  const view = render(draw(live(false)));
  expect(screen.queryByRole("link", { name: "TV destinations" })).toBeNull();
  view.rerender(draw(live(true)));
  expect(screen.getByRole("link", { name: "TV destinations" })).toBeVisible();
});

it("changes only when a section's items or the active section change", () => {
  expect(sidebarSectionsKey(live(false))).toBe(sidebarSectionsKey(live(false)));
  expect(sidebarSectionsKey(live(false))).not.toBe(sidebarSectionsKey(live(true)));
  expect(sidebarSectionsKey([{ id: "live" }])).toBe("live:0");
});
