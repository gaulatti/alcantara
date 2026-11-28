import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PROMQL_CMD,
  FALLBACK_ACCEPTED,
  PRESENT_AT_START,
  TARGETS,
  encodeQuery,
  gate,
  main,
  targetQueries,
  vectorOf,
} from "./renderer-auth-closer-gate.mjs";

// The renderer-key closer's gate against a stand-in Prometheus and secret status. Fictional values, built here.
const vector = (...rows) => JSON.stringify({ status: "success", data: { resultType: "vector", result: rows } });
const row = (value, metric = {}) => ({ metric, value: [1_800_000_000, String(value)] });
const TARGET = { job: "service-native-alcantara", instance: "alcantara-backend:3000" };
const q = targetQueries(TARGET);

function prometheus(overrides = {}) {
  const answers = {
    [FALLBACK_ACCEPTED]: vector(row(0)),
    [PRESENT_AT_START]: vector(row(18)),
    [TARGETS]: vector(row(18, TARGET)),
    [q.worst]: vector(row(1)),
    [q.day]: vector(row(2880)),
    [q.hour]: vector(row(120)),
    ...overrides,
  };
  return async (query) => (query in answers ? answers[query] : null);
}
const clean = '{"fleetKey":true,"sharedKey":true,"programKeys":["station-a"]}';
const byName = (claims) => Object.fromEntries(claims.map((claim) => [claim.name, claim]));

test("passes only when nothing used the fallback for 24 h, the evidence is whole, and the fleet key is placed", async () => {
  const claims = byName(await gate({ query: prometheus(), secretStatus: async () => clean }));
  assert.deepEqual(
    Object.values(claims).map((claim) => [claim.name, claim.ok]),
    [
      ["fallback_unused_24h", true],
      ["window_whole", true],
      ["scrape_whole_24h", true],
      ["fleet_key_in_secret", true],
    ],
  );
  assert.equal(claims.scrape_whole_24h.evidence, "service-native-alcantara/alcantara-backend:3000 up_min=1 scrapes_24h=2880 scrapes_1h=120");
});

test("fails on any use, and on an empty, partial, errored or unreadable answer", async () => {
  const cases = [
    { [FALLBACK_ACCEPTED]: vector(row(0.0001)) },
    { [FALLBACK_ACCEPTED]: vector() },
    { [FALLBACK_ACCEPTED]: vector(row(0), row(0)) },
    { [FALLBACK_ACCEPTED]: JSON.stringify({ status: "error", error: "bad" }) },
    { [FALLBACK_ACCEPTED]: JSON.stringify({ status: "success", warnings: ["partial"], data: { resultType: "vector", result: [row(0)] } }) },
    { [FALLBACK_ACCEPTED]: "<html>" },
    { [FALLBACK_ACCEPTED]: null },
  ];
  for (const override of cases) {
    const claims = byName(await gate({ query: prometheus(override), secretStatus: async () => clean }));
    assert.equal(claims.fallback_unused_24h.ok, false, JSON.stringify(override));
  }
});

test("fails when the window is shorter than 24 h or a scrape gap could hide a use", async () => {
  const short = byName(await gate({ query: prometheus({ [PRESENT_AT_START]: vector() }), secretStatus: async () => clean }));
  assert.equal(short.window_whole.ok, false);
  for (const override of [
    { [q.worst]: vector(row(0)) },
    { [q.day]: vector(row(2000)) },
    { [q.hour]: vector(row(0)) },
    { [q.hour]: vector() },
    { [TARGETS]: vector() },
    { [TARGETS]: vector(row(1, { job: "x" })) },
    { [TARGETS]: null },
  ]) {
    const claims = byName(await gate({ query: prometheus(override), secretStatus: async () => clean }));
    assert.equal(claims.scrape_whole_24h.ok, false, JSON.stringify(override));
  }
});

test("fails without the fleet key, or without a readable secret status", async () => {
  for (const status of ['{"fleetKey":false}', "not json", null, "", "4"]) {
    const claims = byName(await gate({ query: prometheus(), secretStatus: async () => status }));
    assert.equal(claims.fleet_key_in_secret.ok, false, String(status));
  }
  const thrown = byName(await gate({ query: prometheus(), secretStatus: async () => { throw new Error("x"); } }));
  assert.equal(thrown.fleet_key_in_secret.evidence, "not read: no secret status");
});

test("encodes a query so no quote, bracket or brace reaches the shell or the URL as itself", () => {
  const encoded = encodeQuery(`${FALLBACK_ACCEPTED} 'x' (y)*!`);
  assert.doesNotMatch(encoded, /['"(){}\[\]*! ]/);
  assert.equal(decodeURIComponent(encoded), `${FALLBACK_ACCEPTED} 'x' (y)*!`);
  assert.match(DEFAULT_PROMQL_CMD, /\{query\}/);
  assert.equal(vectorOf(vector(row("NaN"))), null);
  assert.equal(vectorOf(JSON.stringify({ status: "success", data: { resultType: "matrix", result: [] } })), null);
});

test("prints one line per claim, exits 0 only when all hold, and refuses a command with no {query}", async () => {
  const lines = [];
  const fake = prometheus();
  const run = async (command) => {
    if (command === "status") return clean;
    const encoded = command.match(/q=(.*)$/)[1];
    return fake(decodeURIComponent(encoded));
  };
  const env = { PROMQL_CMD: "promql q={query}", SECRET_STATUS_CMD: "status" };
  assert.equal(await main(env, { run, print: (line) => lines.push(line), now: () => "T" }), 0);
  assert.deepEqual(lines.map((line) => line.split(" ").slice(0, 3).join(" ")), [
    "1 fallback_unused_24h T",
    "1 window_whole T",
    "1 scrape_whole_24h T",
    "1 fleet_key_in_secret T",
  ]);
  assert.equal(await main({ ...env, SECRET_STATUS_CMD: "nothing" }, { run, print: () => undefined }), 1);
  assert.equal(await main({ PROMQL_CMD: "no placeholder" }, { run, print: () => undefined }), 2);
});
