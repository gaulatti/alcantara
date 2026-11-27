import assert from "node:assert/strict";
import test from "node:test";
import { WINDOW_MS, gate, livekitEvents, workerEvents } from "./host-mic-gate.mjs";

const publish = (at, identity, kind = "audio") =>
  `${at}\tINFO\tlivekit.pub\trtc/participant.go:2354\tmediaTrack published\t{"room": "alcantara-main", "participant": "${identity}", "kind": "${kind}", "trackInfo": {"name": "<redacted>"}}`;
const subscribed = (at, identity, track = "onair:host") => `${at} {"event":"contribution","message":"track subscribed","identity":"${identity}","track":"${track}"}`;
const created = "2026-11-26T22:54:25Z";
const after = Date.parse("2026-11-28T13:00:00Z");
const run = (livekit = "", worker = "", now = after, livekitCreated = created) =>
  gate({ livekit: livekitEvents(livekit), worker: workerEvents(worker), livekitCreated, now });

test("is met after 24 hours with only the host-mic identity and guests publishing", () => {
  const result = run(
    [publish("2026-11-27T14:34:20Z", "operator-host-mic-main"), publish("2026-11-27T15:00:00Z", "guest-1"), publish("2026-11-27T15:00:00Z", "operator-1a-b", "video")].join("\n"),
    subscribed("2026-11-27T14:34:20Z", "operator-host-mic-main"),
  );
  assert.equal(result.ok, true);
});

test("is not met before 24 hours have passed since the rollout", () => {
  assert.equal(run("", "", after - 3600 * 1000).ok, false);
});

test("restarts the 24 hours at a sighting, from either log, and ignores one before the rollout", () => {
  const sighting = "2026-11-28T01:00:00Z";
  for (const [livekit, worker] of [
    [publish(sighting, "operator-1a2b-uuid"), ""],
    ["", subscribed(sighting, "operator-1a2b-uuid")],
  ]) {
    assert.equal(run(livekit, worker).ok, false);
    assert.equal(run(livekit, worker, Date.parse(sighting) + WINDOW_MS).ok, true);
  }
  assert.equal(run(publish("2026-11-27T12:00:00Z", "operator-1a2b-uuid")).ok, true);
  assert.equal(run("", subscribed("2026-11-28T01:00:00Z", "operator-1a2b-uuid", "talkback:all")).ok, true);
});

test("is not met when the LiveKit logs cannot reach back to the rollout, and refuses lines it cannot read", () => {
  assert.equal(run("", "", after, "2026-11-27T13:00:00Z").ok, false);
  assert.throws(() => livekitEvents("garbage mediaTrack published"), /unreadable/);
  assert.throws(() => workerEvents('{"message":"track subscribed","identity":"x"}'.replace('"message":"track subscribed"', '"message":"track subscribed"')), /timestamps|JSON/);
});
