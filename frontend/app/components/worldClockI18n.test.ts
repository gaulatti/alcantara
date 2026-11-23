import { describe, expect, it } from "vitest";
import { t } from "./worldClockI18n";

// The world clock's city names moved here with WorldClocks (gaulatti/alcantara#381).
describe("worldClockI18n", () => {
  it("names a city in each language", () => {
    expect(t("city.NEW YORK", "en")).toBe("NEW YORK");
    expect(t("city.NEW YORK", "es")).not.toBe("");
    expect(t("city.ROME", "it")).not.toBe("");
  });

  it("returns the key for a city it doesn't know", () => {
    expect(t("city.ATLANTIS", "en")).toBe("city.ATLANTIS");
  });
});
