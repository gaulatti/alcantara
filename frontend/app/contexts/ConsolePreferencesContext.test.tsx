import { describe, expect, it } from "vitest";
import { preferenceCacheIdentity } from "./ConsolePreferencesContext";

describe("canonical preference cache identity", () => {
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
});
