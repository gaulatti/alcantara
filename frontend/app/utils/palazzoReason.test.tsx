import { expect, it } from "vitest";
import { engineStatusLabel, engineUnavailableLabel, palazzoReasonText } from "./palazzoReason";

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

it("says a playout that cannot be asked is unreachable, and keeps not configured for the real answer", () => {
  const notConfigured = { reason: "not-configured" };
  expect(engineStatusLabel({ serverUnreachable: false, playoutUnreachable: true, status: null })).toBe("Playout unreachable");
  // A 5xx or a timeout is not the answer "not configured", even when a reason was held before.
  expect(engineStatusLabel({ serverUnreachable: false, playoutUnreachable: true, status: notConfigured })).toBe("Playout unreachable");
  expect(engineStatusLabel({ serverUnreachable: false, playoutUnreachable: false, status: notConfigured })).toBe("Engine unavailable: not configured");
  expect(engineStatusLabel({ serverUnreachable: true, playoutUnreachable: true, status: null })).toBe("Can't reach the Alcántara server");
});

