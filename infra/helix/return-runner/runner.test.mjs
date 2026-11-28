import test from "node:test";
import assert from "node:assert/strict";
import { allKeys, createRunner, keyFor, readConfig, wantedPrograms, redact, watchPage, BACKOFF_MS, GONE_MS, STUCK_MS } from "./runner.mjs";

const env = { ALCANTARA_API_URL: "https://api.example/", ALCANTARA_APP_URL: "https://app.example", WEBRTC_RENDERER_KEY: "secret-key" };
const config = readConfig(env);
const answer = (programs, status = 200) => async () => new Response(JSON.stringify({ programs }), { status });

function harness() {
  let time = 0;
  const lines = [];
  const opened = [];
  const closed = [];
  const states = new Map();
  const runner = createRunner({
    config: { ...config, maxRooms: 2 },
    now: () => time,
    log: (line) => lines.push(line),
    openPage: async (id) => {
      if (id === "broken") throw new TypeError("https://app.example/return-router/broken secret-key");
      opened.push(id);
      return { page: { evaluate: async () => states.get(id) ?? "connected" }, close: async () => void closed.push(id) };
    },
  });
  return { runner, opened, closed, states, lines, advance: (ms) => (time += ms) };
}

test("requires its settings and a browser it knows", () => {
  assert.equal(config.api, "https://api.example");
  assert.throws(() => readConfig({ ...env, WEBRTC_RENDERER_KEY: " " }), /WEBRTC_RENDERER_KEY/);
  assert.throws(() => readConfig({ ...env, WEBRTC_BROWSER: "ie" }), /chromium, webkit or firefox/);
});

// Fictional keys, built here.
const FLEET = "fleet-key-fictional-built-in-this-test-0000";
const STATION = "alrk_fictional-key-for-station-a";

test("reads the fleet key, each program's key and the shared key, and refuses a key map it cannot use", () => {
  const keyed = readConfig({ ...env, WEBRTC_FLEET_KEY: FLEET, WEBRTC_PROGRAM_KEYS: JSON.stringify({ "station-a": STATION }) });
  assert.equal(keyed.fleet, FLEET);
  assert.equal(keyFor(keyed, "station-a"), STATION);
  assert.equal(keyFor(keyed, "station-b"), "secret-key");
  assert.deepEqual(allKeys(keyed).sort(), [FLEET, STATION, "secret-key"].sort());
  const fleetOnly = readConfig({ ...env, WEBRTC_RENDERER_KEY: "", WEBRTC_FLEET_KEY: FLEET });
  assert.equal(keyFor(fleetOnly, "station-a"), "");
  assert.throws(() => readConfig({ ...env, WEBRTC_RENDERER_KEY: "" }), /WEBRTC_FLEET_KEY or WEBRTC_RENDERER_KEY is required/);
  assert.throws(() => readConfig({ ...env, WEBRTC_PROGRAM_KEYS: "{" }), /WEBRTC_PROGRAM_KEYS is not JSON/);
  assert.throws(() => readConfig({ ...env, WEBRTC_PROGRAM_KEYS: "[]" }), /WEBRTC_PROGRAM_KEYS is not an object/);
  assert.throws(() => readConfig({ ...env, WEBRTC_PROGRAM_KEYS: "null" }), /WEBRTC_PROGRAM_KEYS is not an object/);
  for (const entry of [{ "../x": STATION }, { "station-a": 4 }, { "station-a": " " }])
    assert.throws(() => readConfig({ ...env, WEBRTC_PROGRAM_KEYS: JSON.stringify(entry) }), /not a program id and a key/);
});

test("asks for the router list with the fleet key when it has one", async () => {
  const seen = [];
  await wantedPrograms(readConfig({ ...env, WEBRTC_FLEET_KEY: FLEET }), [], async (_url, init) => {
    seen.push(init.headers["X-Renderer-Key"]);
    return new Response(JSON.stringify({ programs: [] }));
  });
  assert.deepEqual(seen, [FLEET]);
});

test("redacts every key it holds", () => {
  assert.equal(redact(`a ${FLEET} b ${STATION} c`, [FLEET, STATION, ""]), "a <key> b <key> c");
});

test("sends the key in a header, never in the address, and keeps only program ids", async () => {
  const seen = [];
  const result = await wantedPrograms(config, ["modoitaliano.fm"], async (url, init) => {
    seen.push([url, init.headers["X-Renderer-Key"]]);
    return new Response(JSON.stringify({ programs: ["modoitaliano.fm", "../x", 4, "modoitaliano.fm"] }));
  });
  assert.deepEqual(result.programs, ["modoitaliano.fm"]);
  assert.deepEqual(seen, [["https://api.example/webrtc/return-routers?running=modoitaliano.fm", "secret-key"]]);
});

test("opens what is wanted, and keeps pages when the backend says nothing", async () => {
  const h = harness();
  await h.runner.tick(answer(["a", "b", "c"]));
  assert.deepEqual(h.opened, ["a", "b"]);
  await h.runner.tick(answer(null, 404));
  await h.runner.tick(async () => {
    throw new Error("offline");
  });
  assert.deepEqual(h.closed, []);
  assert.deepEqual(h.runner.status(), [{ programId: "a", state: "connected" }, { programId: "b", state: "connected" }]);
});

test("closes a page only after its program has been gone a while, so a restarted backend cuts nothing", async () => {
  const h = harness();
  await h.runner.tick(answer(["a"]));
  await h.runner.tick(answer([]));
  h.advance(GONE_MS - 1);
  await h.runner.tick(answer([]));
  assert.deepEqual(h.closed, []);
  // Back in the list: the count starts again.
  await h.runner.tick(answer(["a"]));
  h.advance(GONE_MS);
  await h.runner.tick(answer([]));
  assert.deepEqual(h.closed, []);
  // While the backend cannot be asked, absence does not accumulate.
  h.advance(GONE_MS * 3);
  await h.runner.tick(async () => {
    throw new Error("deploying");
  });
  await h.runner.tick(answer([]));
  assert.deepEqual(h.closed, []);
  h.advance(GONE_MS);
  await h.runner.tick(answer([]));
  assert.deepEqual(h.closed, ["a"]);
});

test("asks with the last ETag and treats 304 as the same list", async () => {
  const h = harness();
  const sent = [];
  const backend = async (url, init) => {
    sent.push(init.headers["If-None-Match"] ?? null);
    return init.headers["If-None-Match"] === "v1"
      ? new Response(null, { status: 304 })
      : new Response(JSON.stringify({ programs: ["a"] }), { headers: { etag: "v1" } });
  };
  await h.runner.tick(backend);
  await h.runner.tick(backend);
  await h.runner.tick(backend);
  // The address changes once a page is running, so the first repeat asks again in full.
  assert.deepEqual(sent, [null, null, "v1"]);
  assert.deepEqual(h.closed, []);
  assert.match(h.runner.metrics(), /return_runner_polls_total\{result="unchanged"\} 1/);
});

test("opens a failed or stuck page again after a growing wait, and logs no key or address", async () => {
  const h = harness();
  h.states.set("a", "failed");
  h.states.set("b", "starting");
  await h.runner.tick(answer(["a", "b"]));
  h.advance(6_000);
  await h.runner.tick(answer(["a", "b"]));
  assert.deepEqual(h.closed, ["a"]);
  assert.deepEqual(h.opened, ["a", "b"]);
  h.advance(BACKOFF_MS[0]);
  await h.runner.tick(answer(["a", "b"]));
  assert.deepEqual(h.opened, ["a", "b", "a"]);
  h.states.set("a", "connected");
  h.advance(STUCK_MS);
  await h.runner.tick(answer(["a", "b"]));
  assert.deepEqual(h.closed, ["a", "b"]);
  await h.runner.tick(answer(["broken"]));
  assert.ok(h.lines.some((line) => line === "return router failed to open for broken: TypeError"));
  assert.ok(!h.lines.join("\n").includes("secret-key"));
  assert.match(h.runner.metrics(), /return_runner_opens_total\{result="failed"\} 1/);
  assert.ok(!h.runner.metrics().includes("broken"));
});

test("keeps the router's own diagnostics and its failures, with nothing credential-like", () => {
  const handlers = {};
  const lines = [];
  watchPage({ on: (event, handler) => (handlers[event] = handler) }, "a", "secret-key", (line) => lines.push(line));
  const message = (type, text) => handlers.console({ type: () => type, text: () => text });
  message("log", "[return-router] levels program=0.0000 mixes=1 mixpeak=0");
  message("log", "something else the page said");
  message("error", "failed wss://livekit.example/rtc?access_token=eyJhbGciOiJIUzI1NiJ9.abc with secret-key");
  handlers.pageerror(new Error("boom"));
  handlers.requestfailed({ method: () => "GET", url: () => "https://api.example/webrtc/return-audio?ticket=abc123", failure: () => ({ errorText: "net::ERR_FAILED" }) });
  handlers.response({ status: () => 502, url: () => "https://api.example/webrtc/renderer-state?x=1", request: () => ({ method: () => "POST" }) });
  handlers.response({ status: () => 200, url: () => "https://api.example/ok", request: () => ({ method: () => "GET" }) });
  assert.deepEqual(lines, [
    "a: [return-router] levels program=0.0000 mixes=1 mixpeak=0",
    "a: page console error: failed wss://livekit.example/rtc?<redacted> with <key>",
    "a: page error: boom",
    "a: request failed: GET https://api.example/webrtc/return-audio net::ERR_FAILED",
    "a: HTTP 502 POST https://api.example/webrtc/renderer-state",
  ]);
  assert.equal(redact("token abcdefghijklmnopqrstuvwxyz0123456789ABCD.sig end"), "token <redacted> end");
});
