import assert from "node:assert/strict";
import { test } from "node:test";
import { RUNS, outcome, passed, routerLines, selectRuns, summaryLine } from "./return-proof-all.mjs";

const run = (browser, peak, copy = "You're hearing the studio") =>
  outcome(browser, [
    '{"step":"guest-joined","ok":true}',
    `WAITING FOR ADMIT ${browser}`,
    '{"step":"guest-admitted","ok":true}',
    '{"step":"return-track","ok":true}',
    `{"step":"guest-copy","ok":${copy === "You're hearing the studio"},"copy":${JSON.stringify(copy)}}`,
    `{"step":"return-level","ok":${peak >= 0.01},"peak":${peak}}`,
  ]);

test("passes only when all three heard something", () => {
  assert.equal(passed([run("chromium", 0.2), run("webkit", 0.1), run("firefox", 0.3)], 3), true);
  assert.equal(passed([run("chromium", 0.2), run("webkit", 0), run("firefox", 0.3)], 3), false);
  assert.equal(passed([run("chromium", 0.2)], 3), false);
});

test("reports how far a browser got", () => {
  const result = outcome("webkit", ['{"step":"guest-joined","ok":true}', '{"step":"error","ok":false,"error":"Timeout"}']);
  assert.equal(summaryLine(result), "webkit: joined yes, admitted NO, return track NO, return peak 0, error: Timeout");
  assert.match(summaryLine(run("firefox", 0.002)), /below the 0\.01 audible level/);
});

test("fails a browser whose guest copy is not 'You're hearing the studio' while audio flows", () => {
  const connecting = run("webkit", 0.2, "Connecting you to the studio sound…");
  assert.equal(connecting.copyOk, false);
  assert.equal(passed([run("chromium", 0.2), connecting, run("firefox", 0.3)], 3), false);
  const stalled = run("firefox", 0.3, "The studio sound isn't reaching you yet.");
  assert.equal(passed([run("chromium", 0.2), run("webkit", 0.1), stalled], 3), false);
});

test("prints the guest-facing copy per browser, and says when it is not playing", () => {
  assert.match(summaryLine(run("chromium", 0.2)), /guest copy "You're hearing the studio"$/);
  const line = summaryLine(run("webkit", 0.2, "Connecting you to the studio sound…"));
  assert.match(line, /guest copy "Connecting you to the studio sound…" \(NOT playing while audio flows\)/);
});

test("keeps the last 40 router lines", () => {
  const log = ["return runner started", ...Array.from({ length: 45 }, (_, i) => `t [return-router] ${i}`)].join("\n");
  const lines = routerLines(log);
  assert.equal(lines.length, 40);
  assert.equal(lines[0], "t [return-router] 5");
});

test("runs the three engines, the two phones and the TCP run, and can be told which", () => {
  assert.deepEqual(
    RUNS.map((r) => [r.name, r.engine, r.device ?? ""]),
    [["chromium", "chromium", ""], ["webkit", "webkit", ""], ["firefox", "firefox", ""], ["iphone", "webkit", "iPhone 15"], ["android", "chromium", "Pixel 7"], ["chromium-tcp", "chromium", ""]],
  );
  assert.deepEqual(selectRuns("iphone, android").map((r) => r.name), ["iphone", "android"]);
  assert.equal(selectRuns("").length, 6);
  assert.throws(() => selectRuns("safari"), /unknown runs: safari/);
  // All six by default: three good results are not a pass.
  assert.equal(passed([run("chromium", 0.2), run("webkit", 0.1), run("firefox", 0.3)]), false);
});

test("has a run with UDP forbidden, and fails it if UDP was used anyway", () => {
  assert.deepEqual(selectRuns("chromium-tcp"), [{ name: "chromium-tcp", engine: "chromium", ice: "tcp" }]);
  const lines = (ok, used) =>
    outcome("chromium-tcp", [
      '{"step":"return-track","ok":true}',
      `{"step":"guest-copy","ok":true,"copy":"You're hearing the studio"}`,
      `{"step":"ice-path","ok":${ok},"used":["${used}"]}`,
      '{"step":"return-level","ok":true,"peak":0.2}',
    ]);
  assert.equal(passed([lines(true, "host tcp -> host :7881")], 1), true);
  assert.equal(passed([lines(false, "host udp -> host :7882")], 1), false);
  assert.match(summaryLine(lines(false, "host udp -> host :7882")), /path: host udp -> host :7882 \(used UDP\)/);
});
