import { expect, it } from "vitest";
import { engineUnavailableLabel, palazzoReasonText } from "./palazzoReason";

it("words each known reason and ignores everything else", () => {
  expect(palazzoReasonText("not-configured")).toBe("not configured");
  expect(palazzoReasonText("disabled")).toBe("disabled in settings");
  expect(palazzoReasonText("url-rejected")).toBe("URL not allowed");
  expect(palazzoReasonText("deploy-candidate")).toBe("deploy candidate");
  for (const unknown of [undefined, null, "", "made-up", "constructor", 7, {}]) {
    expect(palazzoReasonText(unknown)).toBeNull();
  }
});

it("keeps today's text without a known reason", () => {
  expect(engineUnavailableLabel(null)).toBe("Engine unavailable");
  expect(engineUnavailableLabel(undefined)).toBe("Engine unavailable");
  expect(engineUnavailableLabel({})).toBe("Engine unavailable");
  expect(engineUnavailableLabel({ reason: "from-the-future" })).toBe(
    "Engine unavailable",
  );
  expect(engineUnavailableLabel({ reason: "disabled" })).toBe(
    "Engine unavailable: disabled in settings",
  );
});
