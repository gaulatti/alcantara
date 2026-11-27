import { describe, expect, it } from "vitest";
import { NAVIGATION_ICONS } from "./layout";

// The collapsed rail shows only these icons, so two items with one icon read as the same place (gaulatti/alcantara#875).
describe("collapsed navigation icons", () => {
  it("gives each rail item its own icon, so none reads as another", () => {
    const seen = new Map<unknown, string>();
    const repeats: string[] = [];
    for (const [id, element] of Object.entries(NAVIGATION_ICONS)) {
      const type = (element as { type: unknown }).type;
      if (seen.has(type)) repeats.push(`${id} and ${seen.get(type)}`);
      else seen.set(type, id);
    }
    expect(repeats).toEqual([]);
  });

  it("keeps the rundown and the radio log on different icons from each other", () => {
    expect((NAVIGATION_ICONS.rundown as { type: unknown }).type).not.toBe((NAVIGATION_ICONS["radio-log"] as { type: unknown }).type);
  });
});
