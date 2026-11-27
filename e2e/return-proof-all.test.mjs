import assert from "node:assert/strict";
import { test } from "node:test";
import { outcome, passed, routerLines, summaryLine } from "./return-proof-all.mjs";

const run = (browser, peak) =>
  outcome(browser, [
    '{"step":"guest-joined","ok":true}',
    `WAITING FOR ADMIT ${browser}`,
    '{"step":"guest-admitted","ok":true}',
    '{"step":"return-track","ok":true}',
    `{"step":"return-level","ok":${peak >= 0.01},"peak":${peak}}`,
  ]);

test("passes only when all three heard something", () => {
  assert.equal(passed([run("chromium", 0.2), run("webkit", 0.1), run("firefox", 0.3)]), true);
  assert.equal(passed([run("chromium", 0.2), run("webkit", 0), run("firefox", 0.3)]), false);
  assert.equal(passed([run("chromium", 0.2)]), false);
});

test("reports how far a browser got", () => {
  const result = outcome("webkit", ['{"step":"guest-joined","ok":true}', '{"step":"error","ok":false,"error":"Timeout"}']);
  assert.equal(summaryLine(result), "webkit: joined yes, admitted NO, return track NO, return peak 0, error: Timeout");
  assert.match(summaryLine(run("firefox", 0.002)), /below the 0\.01 audible level/);
});

test("keeps the last 40 router lines", () => {
  const log = ["return runner started", ...Array.from({ length: 45 }, (_, i) => `t [return-router] ${i}`)].join("\n");
  const lines = routerLines(log);
  assert.equal(lines.length, 40);
  assert.equal(lines[0], "t [return-router] 5");
});
