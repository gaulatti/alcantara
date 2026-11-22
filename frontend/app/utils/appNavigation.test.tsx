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
    expect(names).toHaveLength(8);
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
