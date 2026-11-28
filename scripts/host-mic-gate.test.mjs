import assert from "node:assert/strict";
import test from "node:test";
import { ROLLOUT, WINDOW_MS, gate, livekitEvents, workerEvents } from "./host-mic-gate.mjs";

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

test("opens the window at the rollout when the container is older", () => {
  const day = Date.parse(ROLLOUT) + WINDOW_MS;
  assert.equal(run("", "", day - 1).ok, false);
  assert.equal(run("", "", day).ok, true);
});

test("opens the window at the container's creation when that is later than the rollout", () => {
  const recreated = "2026-11-28T01:18:44Z";
  const day = Date.parse(recreated) + WINDOW_MS;
  assert.equal(run("", "", day - 1, recreated).ok, false);
  const met = run("", "", day, recreated);
  assert.equal(met.ok, true);
  assert.match(met.rows[0][2], /window_start=2026-11-28T01:18:44\.000Z/);
  // A sighting after the creation still restarts the 24 hours; one saved from before the window does not count in it.
  const sighting = "2026-11-28T02:00:00Z";
  assert.equal(run(publish(sighting, "operator-1a2b-uuid"), "", day, recreated).ok, false);
  const earlier = run("", subscribed("2026-11-27T20:00:00Z", "operator-1a2b-uuid"), day, recreated);
  assert.equal(earlier.ok, true);
  assert.equal(earlier.rows[1][1], true);
});

test("is not met when the container's creation time cannot be read, and refuses lines it cannot read", () => {
  assert.equal(run("", "", after, "").ok, false);
  assert.throws(() => livekitEvents("garbage mediaTrack published"), /unreadable/);
  assert.throws(() => workerEvents('{"message":"track subscribed","identity":"x"}'.replace('"message":"track subscribed"', '"message":"track subscribed"')), /timestamps|JSON/);
});
