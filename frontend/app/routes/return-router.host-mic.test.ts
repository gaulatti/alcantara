import { expect, it } from "vitest";
import { isHostMic } from "./return-router";

// Which onair:host the guests hear (gaulatti/alcantara#879): the show's one host mic, and nothing else.

const host = { participantIdentity: "operator-host-mic-main", trackName: "onair:host" };

it("takes the show's host mic", () => {
  expect(isHostMic(host, "main")).toBe(true);
});

it("never takes an ordinary operator connection, another track, another show's host mic, or a non-operator", () => {
  expect(isHostMic({ participantIdentity: "operator-1a2b-uuid", trackName: "onair:host" }, "main")).toBe(false);
  expect(isHostMic({ ...host, trackName: "talkback:all" }, "main")).toBe(false);
  expect(isHostMic({ participantIdentity: "operator-host-mic-other", trackName: "onair:host" }, "main")).toBe(false);
  expect(isHostMic({ participantIdentity: "guest-cy", trackName: "onair:host" }, "main")).toBe(false);
});
