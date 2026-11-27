import { describe, expect, it } from "vitest";
import { OVERLAY_COMPONENTS as componentRegistry } from "./components";

// gaulatti/alcantara#391: the bracket is registered under Giorgia's id only. The legacy id is no longer a registered
// component, so a stored legacy id is an unknown one: the program shows nothing for it and never crashes.
describe("Giorgia bracket registration", () => {
  it("registers modoitaliano-giorgia-bracket and no longer registers the legacy id", () => {
    const giorgia = componentRegistry.find((entry) => entry.id === "modoitaliano-giorgia-bracket");
    expect(giorgia).toBeDefined();
    expect(giorgia?.hasConfigurableSceneAttributes).toBe(true);
    expect(componentRegistry.some((entry) => entry.id === "modoitaliano-bracket")).toBe(false);
  });
});
