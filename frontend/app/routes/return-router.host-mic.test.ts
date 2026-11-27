import { expect, it } from "vitest";
import { isHostMic } from "./return-router";

// Which onair:host the guests hear (gaulatti/alcantara#879): the show's one host mic, or, while it is absent, a console
// that predates it (transitional, gaulatti/alcantara#880). Never both.

const host = { participantIdentity: "operator-host-mic-main", trackName: "onair:host" };
const old = { participantIdentity: "operator-1a2b-uuid", trackName: "onair:host" };

it("takes an older console's host mic alone, and only the show's host mic once both are present", () => {
  expect(isHostMic(old, "main", [old])).toBe(true);
  expect(isHostMic(host, "main", [host])).toBe(true);
  expect(isHostMic(host, "main", [old, host])).toBe(true);
  expect(isHostMic(old, "main", [old, host])).toBe(false);
});

it("never takes another track, another show's host mic, or a non-operator", () => {
  expect(isHostMic({ ...host, trackName: "talkback:all" }, "main", [])).toBe(false);
  expect(isHostMic({ participantIdentity: "operator-host-mic-other", trackName: "onair:host" }, "main", [])).toBe(false);
  expect(isHostMic({ participantIdentity: "guest-cy", trackName: "onair:host" }, "main", [])).toBe(false);
  expect(isHostMic(old, "main")).toBe(true);
});
