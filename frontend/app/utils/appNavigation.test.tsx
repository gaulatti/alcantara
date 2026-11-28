import { describe, expect, it } from "vitest";
import {
  getAppNavigationSections,
  isNavigationItemActive,
} from "./appNavigation";

function labels(type: "tv" | "radio" | "both") {
  return getAppNavigationSections({
    programType: type,
    canViewBroadcasts: true,
    includeDeveloperTools: false,
  }).flatMap((section) => section.items.map((item) => item.label));
}

describe("program-aware application navigation", () => {
  it("keeps television-only preparation out of the radio workflow", () => {
    expect(labels("radio")).toEqual([
      "Radio desk",
      "Rundown",
      "Dayparts",
      "Guest calls",
      "Media",
      "Shows",
      "Radio distribution",
    ]);
  });

  it("gives simulcast explicit access to both legs", () => {
    const simulcast = labels("both");
    expect(simulcast).toContain("Simulcast control");
    expect(simulcast).toContain("TV destinations");
    expect(simulcast).toContain("Radio distribution");
    expect(simulcast.filter((label) => label === "Rundown")).toHaveLength(1);
    expect(simulcast).toContain("Scene templates");
  });

  it("links the external sources page beside guest calls on a television leg (#45)", () => {
    for (const type of ["tv", "both"] as const) {
      const live = getAppNavigationSections({
        programType: type,
        canViewBroadcasts: false,
        includeDeveloperTools: false,
      }).find((section) => section.id === "live")!;
      const ids = live.items.map((item) => item.id);
      expect(ids.indexOf("sources")).toBe(ids.indexOf("calls") + 1);
      expect(live.items.find((item) => item.id === "sources")).toEqual({
        id: "sources",
        href: "/sources",
        label: "External sources",
      });
    }
    expect(labels("radio")).not.toContain("External sources");
  });

  // alcantara#875: a cued guest goes out on the radio, so a radio show reaches calls from its menu too.
  it("links guest calls on every kind of show", () => {
    for (const type of ["tv", "radio", "both"] as const) {
      expect(labels(type).filter((label) => label === "Guest calls")).toHaveLength(1);
    }
  });

  it("does not expose developer tools in the production navigation", () => {
    expect(labels("tv")).not.toContain("Component catalog");
  });

  it("keeps the Development labels short enough for the sidebar, and distinct", () => {
    const developer = getAppNavigationSections({
      programType: "tv",
      canViewBroadcasts: true,
      includeDeveloperTools: true,
    }).find((section) => section.id === "developer")!;
    const names = developer.items.map((item) => item.label);
    expect(names).toHaveLength(10);
    expect(new Set(names).size).toBe(names.length);
    // The sidebar truncates a nested label at about 18 characters.
    for (const name of names) expect(name.length).toBeLessThanOrEqual(17);
  });

  it("treats the legacy control route as the live destination", () => {
    expect(isNavigationItemActive("/control", "/")).toBe(true);
    expect(isNavigationItemActive("/media", "/media")).toBe(true);
    expect(isNavigationItemActive("/songs/12", "/media")).toBe(false);
  });
});
