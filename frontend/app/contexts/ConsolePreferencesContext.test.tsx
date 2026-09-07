import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultConsoleProfile,
  preferenceCacheIdentity,
  readPreferenceCache,
} from "./ConsolePreferencesContext";

describe("canonical preference cache identity", () => {
  beforeEach(() => window.localStorage.clear());

  it("uses the verified principal across pool subjects", () => {
    expect(
      preferenceCacheIdentity({
        id: "pool-subject-a",
        principalId: " principal-a ",
      }),
    ).toBe("principal-a");
    expect(
      preferenceCacheIdentity({
        id: "pool-subject-b",
        principalId: "principal-a",
      }),
    ).toBe("principal-a");
  });

  it("falls back to the current subject while no principal is resolved", () => {
    expect(
      preferenceCacheIdentity({ id: "legacy-subject", principalId: null }),
    ).toBe("legacy-subject");
  });

  it("migrates a legacy subject cache when a principal first becomes available", () => {
    const cached = { version: 4, profile: defaultConsoleProfile("desktop") };
    window.localStorage.setItem(
      "alcantara.console.acknowledged.legacy-subject.desktop",
      JSON.stringify(cached),
    );

    expect(
      readPreferenceCache(
        { id: "legacy-subject", principalId: "principal-a" },
        "desktop",
      ),
    ).toEqual(cached);
    expect(
      JSON.parse(
        window.localStorage.getItem(
          "alcantara.console.acknowledged.principal-a.desktop",
        ) ?? "null",
      ),
    ).toEqual(cached);
  });

  it("prefers an existing principal cache over the legacy subject cache", () => {
    const canonical = {
      version: 5,
      profile: { ...defaultConsoleProfile("desktop"), workspace: "audio" },
    };
    const legacy = { version: 4, profile: defaultConsoleProfile("desktop") };
    window.localStorage.setItem(
      "alcantara.console.acknowledged.principal-a.desktop",
      JSON.stringify(canonical),
    );
    window.localStorage.setItem(
      "alcantara.console.acknowledged.legacy-subject.desktop",
      JSON.stringify(legacy),
    );

    expect(
      readPreferenceCache(
        { id: "legacy-subject", principalId: "principal-a" },
        "desktop",
      ),
    ).toEqual(canonical);
  });
});
