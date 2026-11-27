#!/usr/bin/env node
// The guest call in every engine the matrix covers, against a dotted program ID (not only "main"), at 375 px with touch:
// chromium, webkit (closest to iPhone Safari) and firefox, one after another. It prints each engine's result and
// exits non-zero if any engine fails. Each engine runs webrtc-call.mjs with WEBRTC_ENGINE set.
//
// Configuration: the same environment as webrtc-call.mjs. ALCANTARA_PROGRAM_ID defaults to radio-demo.fm here.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENGINES = ["chromium", "webkit", "firefox"];
const results = [];
for (const engine of ENGINES) {
  const run = spawnSync(process.execPath, [join(here, "webrtc-call.mjs")], {
    env: { ...process.env, WEBRTC_ENGINE: engine, ALCANTARA_PROGRAM_ID: process.env.ALCANTARA_PROGRAM_ID || "radio-demo.fm" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const lines = (run.stdout || "").split("\n").filter(Boolean);
  const last = lines.at(-1) ?? "";
  const ok = run.status === 0;
  results.push({ engine, ok, exit: run.status, lastStep: last.slice(0, 240) });
  console.log(JSON.stringify({ engine, ok, exit: run.status, steps: lines.length, lastStep: last.slice(0, 240) }));
  if (!ok && run.stderr) console.log(JSON.stringify({ engine, stderr: run.stderr.split("\n").slice(0, 6).join(" | ").slice(0, 600) }));
}
const failed = results.filter((result) => !result.ok).map((result) => result.engine);
console.log(JSON.stringify({ summary: { engines: ENGINES.length, passed: results.length - failed.length, failed } }));
process.exit(failed.length ? 1 : 0);
