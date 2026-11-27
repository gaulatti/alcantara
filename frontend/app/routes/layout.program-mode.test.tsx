import { describe, expect, it } from "vitest";
import { programModeLabelFor } from "./layout";

// The header's program mode (gaulatti/alcantara#875): it names the mode only once the program's type is known.
describe("programModeLabelFor", () => {
  it("names the mode of a loaded program", () => {
    expect(programModeLabelFor("radio")).toBe("Radio");
    expect(programModeLabelFor("both")).toBe("Simulcast");
    expect(programModeLabelFor("tv")).toBe("Television");
  });

  it("says the program is loading, and does not name Television, while its type is unknown", () => {
    expect(programModeLabelFor(undefined)).toBe("Loading program…");
  });
});
