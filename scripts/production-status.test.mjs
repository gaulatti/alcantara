import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  blobHash,
  callsHealth,
  containerHealthy,
  cumulusSections,
  deployedCurrent,
  format,
  helixSections,
  hostScript,
  legacyHostMicAbsent,
  liveOffWithoutGuest,
  main,
  mcp,
  mcpBody,
  nextSongAccepted,
  palazzoConnected,
  parseInspect,
  parseMetrics,
  parseSections,
  radioAudible,
  shellQuote,
} from "./production-status.mjs";

const AT = "2026-01-01T00:00:00.000Z";
const playing = { status: "playing", icecastConnected: true, outputRms: 0.08, lastSampleAt: AT, liveOnAir: false };
const gauges = (silent, guests) =>
  parseMetrics(`alcantara_radio_output_silent_programs ${silent}\nalcantara_webrtc_on_air_guests ${guests}\n`);

test("radio_audible holds only while Palazzo plays to Icecast above the threshold and the backend hears it", () => {
  assert.equal(radioAudible(playing, gauges(0, 0), AT).ok, 1);
  assert.equal(radioAudible({ ...playing, status: "idle" }, gauges(0, 0), AT).ok, 0);
  assert.equal(radioAudible({ ...playing, icecastConnected: false }, gauges(0, 0), AT).ok, 0);
  assert.equal(radioAudible({ ...playing, outputRms: 0.0005 }, gauges(0, 0), AT).ok, 0);
  assert.equal(radioAudible({ ...playing, outputRms: null }, gauges(0, 0), AT).ok, 0);
  assert.equal(radioAudible(playing, gauges(1, 0), AT).ok, 0);
  assert.match(radioAudible(null, gauges(0, 0), AT).evidence, /^not read: Palazzo/);
  assert.match(radioAudible(playing, new Map(), AT).evidence, /^not read: backend/);
});

test("parseMetrics keeps only the gauges asked for", () => {
  const values = parseMetrics('alcantara_webrtc_on_air_guests 2\nsecret_like_thing 9\nalcantara_x{a="b"} 1\n# HELP y\n', ["alcantara_webrtc_on_air_guests", "alcantara_x"]);
  assert.deepEqual([...values], [["alcantara_webrtc_on_air_guests", 2], ['alcantara_x{a="b"}', 1]]);
});

test("next_song_accepted, palazzo_connected and calls_health read their MCP answers", () => {
  assert.equal(nextSongAccepted({ next: { status: "accepted", playback_id: "p" }, song: { started_at: AT } }, AT).ok, 1);
  assert.equal(nextSongAccepted({ next: { status: "pending" } }, AT).ok, 0);
  assert.match(nextSongAccepted({}, AT).evidence, /next status=none/);
  assert.match(nextSongAccepted(null, AT).evidence, /^not read/);

  assert.equal(palazzoConnected({ palazzo: { connection: "connected", degraded: false } }, AT).ok, 1);
  assert.equal(palazzoConnected({ palazzo: { connection: "connected", degraded: true } }, AT).ok, 0);
  assert.equal(palazzoConnected({ palazzo: { connection: "polling", degraded: false } }, AT).ok, 0);
  assert.equal(palazzoConnected({}, AT).ok, 0);
  assert.match(palazzoConnected(null, AT).evidence, /^not read/);

  const ok = { returnRunner: "ok", contribution: "ok", livekit: "ok", checkedAt: "2026-01-01T00:00:05.000Z" };
  assert.deepEqual(callsHealth(ok, AT), { name: "calls_health", ok: 1, at: ok.checkedAt, evidence: "returnRunner=ok contribution=ok livekit=ok" });
  assert.equal(callsHealth({ ...ok, contribution: "unknown" }, AT).ok, 0);
  assert.equal(callsHealth({ ...ok, checkedAt: undefined }, AT).at, AT);
  assert.match(callsHealth(null, AT).evidence, /^not read/);
});

test("live input is on air only with a guest cued live or a host mic published, and unknown is never off", () => {
  const live = { ...playing, liveOnAir: true };
  assert.equal(liveOffWithoutGuest(playing, gauges(0, 0), null, AT).ok, 1);
  assert.equal(liveOffWithoutGuest(live, gauges(0, 1), 0, AT).ok, 1);
  assert.equal(liveOffWithoutGuest(live, gauges(0, 0), 1, AT).ok, 1);
  assert.equal(liveOffWithoutGuest(live, gauges(0, 0), 0, AT).ok, 0);
  assert.equal(liveOffWithoutGuest(live, gauges(0, 0), null, AT).ok, 0);
  assert.equal(liveOffWithoutGuest({ ...playing, liveOnAir: null }, gauges(0, 0), 0, AT).ok, 0);
  assert.match(liveOffWithoutGuest(null, gauges(0, 0), 0, AT).evidence, /^not read: Palazzo/);
  assert.match(liveOffWithoutGuest(playing, null, 0, AT).evidence, /^not read: backend/);
});

test("a container is current only running, healthy and built from origin/main's source", () => {
  const blob = blobHash("worker");
  const info = parseInspect("running healthy sha256:0123456789abcdef0123 2026-01-01T00:00:00Z", blob);
  const ok = containerHealthy("contribution", info, blob, "abcd1234", AT);
  assert.equal(ok.ok, 1);
  assert.match(ok.evidence, /image=sha256:0123456789ab started=2026-01-01T00:00:00Z source as of abcd1234, matches origin\/main/);
  assert.match(containerHealthy("contribution", info, blobHash("newer"), "abcd1234", AT).evidence, /differs from origin\/main/);
  assert.equal(containerHealthy("contribution", info, blobHash("newer"), null, AT).ok, 0);
  assert.equal(containerHealthy("contribution", { ...info, health: "unhealthy" }, blob, null, AT).ok, 0);
  assert.equal(containerHealthy("contribution", { ...info, status: "exited" }, blob, null, AT).ok, 0);
  const noBlob = parseInspect("running healthy sha256:0 t", "not a hash");
  assert.equal(noBlob.blob, null);
  assert.match(containerHealthy("return_runner", noBlob, blob, null, AT).evidence, /source unread/);
  assert.equal(parseInspect(null, blob), null);
  assert.match(containerHealthy("return_runner", null, blob, null, AT).evidence, /^not read: alcantara-return-runner/);
});

test("blobHash is git's blob id", () => {
  const dir = mkdtempSync(join(tmpdir(), "status-blob-"));
  try {
    writeFileSync(join(dir, "f"), "hello\n");
    assert.equal(blobHash("hello\n"), execFileSync("git", ["hash-object", join(dir, "f")], { encoding: "utf8" }).trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a side is deployed when it is origin/main or nothing its deploy watches changed since", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  assert.match(deployedCurrent("backend", a, a, null, AT).evidence, /is origin\/main/);
  assert.equal(deployedCurrent("backend", a, b, false, AT).ok, 1);
  assert.equal(deployedCurrent("backend", a, b, true, AT).ok, 0);
  assert.match(deployedCurrent("backend", a, b, null, AT, " x").evidence, /diff unread x$/);
  assert.equal(deployedCurrent("frontend", a, b, null, AT).ok, 0);
  assert.match(deployedCurrent("frontend", null, b, false, AT).evidence, /^not read/);
  assert.match(deployedCurrent("frontend", a, null, false, AT).evidence, /^not read: origin\/main/);
});

test("legacy_host_mic_absent counts only old operator-* identities, not the fixed host-mic identity", () => {
  assert.equal(legacyHostMicAbsent({ affects: [] }, AT).ok, 1);
  assert.equal(legacyHostMicAbsent({}, AT).ok, 1);
  const fixed = legacyHostMicAbsent({ affects: [{ id: "operator-host-mic-show" }] }, AT);
  assert.deepEqual([fixed.ok, fixed.evidence], [1, "host_mic_tracks=1 legacy=0"]);
  const legacy = legacyHostMicAbsent({ affects: [{ id: "operator-host-mic-show" }, { id: "operator-abc" }] }, AT);
  assert.deepEqual([legacy.ok, legacy.evidence], [0, "host_mic_tracks=2 legacy=1"]);
  assert.match(legacyHostMicAbsent(null, AT).evidence, /^not read/);
});

test("an MCP call never carries a confirm, and the token goes only in the header", async () => {
  assert.throws(() => mcpBody("call_capability", { confirm: "x" }), /never confirms/);
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, json: async () => ({ result: { content: [{ text: '{"a":1}' }] } }) };
  };
  assert.deepEqual(await mcp("https://api.example.test", "fake-token-built-in-test", "get_on_air", { program_id: "p" }, fetchImpl), { a: 1 });
  assert.equal(seen[0].url, "https://api.example.test/mcp");
  assert.equal(seen[0].init.headers.Authorization, "Bearer fake-token-built-in-test");
  assert.doesNotMatch(seen[0].init.body, /fake-token/);
  assert.deepEqual(JSON.parse(seen[0].init.body).params, { name: "get_on_air", arguments: { program_id: "p" } });

  const refused = async () => ({ ok: true, json: async () => ({ result: { isError: true, content: [{ text: "{}" }] } }) });
  await assert.rejects(mcp("https://x.test", "t", "get_on_air", {}, refused), /refused/);
  const status = async () => ({ ok: false, status: 401 });
  await assert.rejects(mcp("https://x.test", "t", "get_on_air", {}, status), /answered 401/);
});

test("the host scripts run in sh: each section prints its tagged line, and a failing one prints the tag alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "status-host-"));
  try {
    // A stand-in docker that answers like the real one, from what it is asked.
    const fake = join(dir, "docker");
    writeFileSync(
      fake,
      `#!/bin/sh
case "$1 $2" in
  "inspect -f") echo "running healthy sha256:feed 2026-01-01T00:00:00Z" ;;
  "exec -i") cat >/dev/null; case "$*" in *PROGRAM_ID=show.fm*palazzo*) echo '{"status":"playing","liveOnAir":false}' ;; *alcantara-backend*) printf 'alcantara_webrtc_on_air_guests 0\\nalcantara_radio_output_silent_programs 0\\n' ;; esac ;;
  "exec alcantara-contribution") echo 0123456789012345678901234567890123456789 ;;
  *) exit 1 ;;
esac
`,
    );
    chmodSync(fake, 0o755);
    const cumulus = parseSections(execFileSync("sh", ["-s"], { input: hostScript(fake, "show.fm", cumulusSections()), encoding: "utf8" }));
    assert.deepEqual(JSON.parse(cumulus.palazzo), { status: "playing", liveOnAir: false });
    assert.deepEqual([...parseMetrics(cumulus.metrics)], [["alcantara_webrtc_on_air_guests", 0], ["alcantara_radio_output_silent_programs", 0]]);
    assert.equal(cumulus.contribution, "running healthy sha256:feed 2026-01-01T00:00:00Z");
    assert.equal(cumulus.contribution_blob, "0123456789012345678901234567890123456789");
    const helix = parseSections(execFileSync("sh", ["-s"], { input: hostScript(fake, "show.fm", helixSections()), encoding: "utf8" }));
    assert.equal(helix.return_runner, "running healthy sha256:feed 2026-01-01T00:00:00Z");
    assert.equal(helix.return_runner_blob, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.deepEqual(parseSections("x\n \nkey \n"), { key: null });
});

test("the formatted line is the bit, the name, the time and the evidence", () => {
  assert.equal(format({ ok: 1, name: "n", at: AT, evidence: "e" }), `1 n ${AT} e`);
});

test("a bad program id or docker command is a usage error", async () => {
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(message);
  try {
    assert.equal(await main({ PROGRAM_ID: "Bad Id" }, () => {}), 2);
    assert.equal(await main({ STATUS_DOCKER: "docker; rm" }, () => {}), 2);
    assert.equal(await main({ ALCANTARA_TOKEN_FILE: "/nonexistent/status-token" }, () => {}), 2);
    const dir = mkdtempSync(join(tmpdir(), "status-token-"));
    try {
      writeFileSync(join(dir, "t"), "  \n");
      assert.equal(await main({ ALCANTARA_TOKEN_FILE: join(dir, "t") }, () => {}), 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 4);
});
