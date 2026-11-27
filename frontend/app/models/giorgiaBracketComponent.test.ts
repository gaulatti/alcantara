import { describe, expect, it } from "vitest";
import { OVERLAY_COMPONENTS as componentRegistry } from "./components";

// gaulatti/alcantara#391: the bracket under Giorgia's id is registered with the same defaults as the legacy bracket it
// replaces, so a scene placed on either id gets the same props and the same editor.
describe("Giorgia bracket registration", () => {
  it("registers modoitaliano-giorgia-bracket with the legacy bracket's defaults", () => {
    const legacy = componentRegistry.find((entry) => entry.id === "modoitaliano-bracket");
    const giorgia = componentRegistry.find((entry) => entry.id === "modoitaliano-giorgia-bracket");
    expect(legacy).toBeDefined();
    expect(giorgia).toBeDefined();
    expect(giorgia?.defaultProps).toEqual(legacy?.defaultProps);
    expect(giorgia?.hasConfigurableSceneAttributes).toBe(true);
  });
});
