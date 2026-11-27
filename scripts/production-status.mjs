#!/usr/bin/env node
// The production status, read only: one line per claim, 1 when it holds and 0 when it does not or could not be read,
// with the read's time and its evidence (docs/production-status.md).
//
//   ALCANTARA_TOKEN_FILE=<0600 file holding an Access token> node scripts/production-status.mjs
//
// It only reads: the MCP read tools (and the dry run of webrtc_host_mic_off, which never sends a confirm, so the server
// cannot run it), the public /health/ready and index page, `docker inspect` and two read-only `docker exec` probes over
// SSH (Palazzo's own /playback/state, the backend's private /metrics), git and the GitHub run list. No writes, no tone,
// no invites. The token is read from its file, sent only as the MCP Authorization header and never printed. Exit 0 when every line is 1,
// 1 when any is 0, 2 on a usage error.
//
// ALCANTARA_API_URL, ALCANTARA_APP_URL, PROGRAM_ID (modoitaliano.fm), CUMULUS_SSH (cumulus.gaulatti.com),
// HELIX_SSH (helix.gaulatti.com), STATUS_DOCKER (docker; for example "sudo docker"), GITHUB_REPO (gaulatti/alcantara).
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Palazzo's output level above which the backend counts the radio as sounding (radio-output-confidence.service). */
export const AUDIO_THRESHOLD = 0.001;
/** Every file whose change starts that side's deploy (.github/workflows/*-deploy.yml `paths`). */
export const DEPLOY_PATHS = {
  backend: ["backend", "deploy", "infra", ".github/workflows/backend-deploy.yml", "scripts/brand-baselines"],
  frontend: ["frontend", ".github/workflows/frontend-deploy.yml"],
};
/** The containers each host must run healthy, and the one source file each is built from. */
export const CONTAINERS = {
  contribution: { name: "alcantara-contribution", file: "/app/worker.mjs", source: "infra/cumulus/contribution/worker.mjs" },
  return_runner: { name: "alcantara-return-runner", file: "/app/runner.mjs", source: "infra/helix/return-runner/runner.mjs" },
};
/** The backend gauges this check reads; nothing else of /metrics leaves the host. */
export const METRICS = ["alcantara_radio_output_silent_programs", "alcantara_webrtc_on_air_guests"];
const LEGACY_HOST_MIC = /^operator-(?!host-mic-)/;

const line = (name, ok, at, evidence) => ({ name, ok: ok ? 1 : 0, at, evidence });
export const format = (row) => `${row.ok} ${row.name} ${row.at} ${row.evidence}`;
const unread = (name, at, why) => line(name, false, at, `not read: ${why}`);

/** `git hash-object` of a file's bytes: what the container runs, compared with a commit's blob. */
export function blobHash(content) {
  const bytes = Buffer.from(content);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** Prometheus text to name{labels} → value, for the gauges asked for only. */
export function parseMetrics(text, names = METRICS) {
  const values = new Map();
  for (const row of String(text).split("\n")) {
    const match = /^([a-z_]+)(\{[^}]*\})? (\S+)$/.exec(row.trim());
    if (match && names.includes(match[1])) values.set(match[1] + (match[2] ?? ""), Number(match[3]));
  }
  return values;
}

/** The radio is heard: Palazzo plays to Icecast above the backend's audio threshold, and the backend agrees. */
export function radioAudible(palazzo, metrics, at) {
  if (!palazzo) return unread("radio_audible", at, "Palazzo state on cumulus");
  const silent = metrics?.get("alcantara_radio_output_silent_programs");
  if (silent === undefined) return unread("radio_audible", at, "backend output_silent_programs");
  const rms = palazzo.outputRms;
  const ok = palazzo.status === "playing" && palazzo.icecastConnected === true && typeof rms === "number" && rms > AUDIO_THRESHOLD && silent === 0;
  return line("radio_audible", ok, at, `palazzo status=${palazzo.status} icecast=${palazzo.icecastConnected} output_rms=${rms} sample=${palazzo.lastSampleAt}; backend silent_programs=${silent}`);
}

export function nextSongAccepted(onAir, at) {
  if (!onAir) return unread("next_song_accepted", at, "MCP get_on_air");
  const status = onAir.next?.status ?? "none";
  return line("next_song_accepted", status === "accepted", at, `next status=${status} playback_id=${onAir.next?.playback_id ?? "none"}; song started_at=${onAir.song?.started_at ?? "none"}`);
}

export function palazzoConnected(health, at) {
  if (!health) return unread("palazzo_connected", at, "MCP get_radio_health");
  const p = health.palazzo ?? {};
  return line("palazzo_connected", p.connection === "connected" && p.degraded === false, at, `connection=${p.connection} degraded=${p.degraded} last_event_at=${p.last_event_at}`);
}

export function callsHealth(chain, at) {
  if (!chain) return unread("calls_health", at, "MCP webrtc_health");
  const parts = ["returnRunner", "contribution", "livekit"];
  return line("calls_health", parts.every((part) => chain[part] === "ok"), chain.checkedAt ?? at, parts.map((part) => `${part}=${chain[part]}`).join(" "));
}

/**
 * Palazzo's live input is off air while nobody should be on it: on air only with a guest cued live or a host
 * microphone published. A live reading Palazzo did not give (absent or stale) is unknown, never off.
 */
export function liveOffWithoutGuest(palazzo, metrics, hostMics, at) {
  const name = "live_onair_false_without_guest";
  if (!palazzo) return unread(name, at, "Palazzo state on cumulus");
  const guests = metrics?.get("alcantara_webrtc_on_air_guests");
  if (guests === undefined) return unread(name, at, "backend on_air_guests");
  const onAir = palazzo.liveOnAir;
  const evidence = `live.onAir=${onAir ?? "absent"} guests_cued_live=${guests} host_mics=${hostMics ?? "unknown"}`;
  if (typeof onAir !== "boolean") return line(name, false, at, evidence);
  if (!onAir || guests > 0) return line(name, true, at, evidence);
  return line(name, typeof hostMics === "number" && hostMics > 0, at, evidence);
}

export function containerHealthy(key, info, mainBlob, sourceCommit, at) {
  const name = `${key}_container`;
  if (!info) return unread(name, at, `${CONTAINERS[key].name} on its host`);
  const current = info.blob !== null && info.blob === mainBlob;
  const ok = info.status === "running" && info.health === "healthy" && current;
  const built = sourceCommit ? `as of ${sourceCommit}` : "of no commit on main";
  const source = info.blob === null ? "unread" : `${built}, ${current ? "matches" : "differs from"} origin/main`;
  return line(name, ok, at, `${info.status}/${info.health} image=${info.image.slice(0, 19)} started=${info.startedAt} source ${source}`);
}

/** Deployed is current when it is origin/main, or nothing that side's deploy watches changed since. */
export function deployedCurrent(side, deployed, main, changed, at, extra = "") {
  const name = `${side}_deployed`;
  if (!deployed) return unread(name, at, `${side} deployed commit`);
  if (!main) return unread(name, at, "origin/main");
  const ok = deployed === main || changed === false;
  const delta = deployed === main ? "is origin/main" : changed === false ? `origin/main ${main.slice(0, 8)} changes no ${side} deploy path since` : changed ? `origin/main ${main.slice(0, 8)} has undeployed ${side} changes` : "diff unread";
  return line(name, ok, at, `${deployed.slice(0, 8)} ${delta}${extra}`);
}

export function legacyHostMicAbsent(plan, at) {
  const name = "legacy_host_mic_absent";
  if (!plan) return unread(name, at, "MCP webrtc_host_mic_off dry run");
  const ids = (plan.affects ?? []).map((affect) => affect.id);
  const legacy = ids.filter((id) => LEGACY_HOST_MIC.test(id));
  return line(name, legacy.length === 0, at, `host_mic_tracks=${ids.length} legacy=${legacy.length}`);
}

/** The JSON-RPC body of one MCP tool call. A dry run never carries a confirm, so the server refuses to run it. */
export function mcpBody(tool, args) {
  if ("confirm" in args) throw new Error("the status check never confirms an action");
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } };
}

export async function mcp(api, token, tool, args, fetchImpl = fetch) {
  const response = await fetchImpl(`${api}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": "alcantara-production-status/1",
    },
    body: JSON.stringify(mcpBody(tool, args)),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`MCP ${tool} answered ${response.status}`);
  const result = (await response.json()).result;
  const text = result?.content?.[0]?.text;
  if (result?.isError || typeof text !== "string") throw new Error(`MCP ${tool} refused`);
  return JSON.parse(text);
}

// Read inside the Palazzo container on cumulus: only these fields leave it, never a title or URL.
const PALAZZO_PROBE = `const r = await fetch("http://127.0.0.1:3100/v1/programs/" + encodeURIComponent(process.env.PROGRAM_ID) + "/playback/state", { signal: AbortSignal.timeout(10000) });
if (!r.ok) process.exit(1);
const s = await r.json();
console.log(JSON.stringify({ status: s.status ?? null, availability: s.availability ?? null, icecastConnected: s.icecast?.connected ?? null, liquidsoapConnected: s.liquidsoap?.connected ?? null, outputRms: s.levels?.output?.rms ?? null, lastSampleAt: s.liquidsoap?.lastSampleAt ?? null, liveOnAir: s.live?.onAir ?? null }));`;
// Read inside the backend container on cumulus, as the deploy does: the scrape token stays in that process.
const METRICS_PROBE = `const r = await fetch("http://127.0.0.1:" + process.env.PORT + "/metrics", { headers: { authorization: "Bearer " + (await import("node:fs")).readFileSync(process.env.METRICS_TOKEN_FILE, "utf8").trim() }, signal: AbortSignal.timeout(10000) });
if (!r.ok) process.exit(1);
const wanted = ${JSON.stringify(METRICS)};
for (const row of (await r.text()).split("\\n")) if (wanted.some((name) => row.startsWith(name + " ") || row.startsWith(name + "{"))) console.log(row);`;
const BLOB_PROBE = (file) =>
  `const c=require("fs").readFileSync(${JSON.stringify(file)});console.log(require("crypto").createHash("sha1").update("blob "+c.length+"\\0").update(c).digest("hex"))`;

/** The shell script sent to a host on stdin: each section prints one tagged line, or the tag alone when unread. */
export function hostScript(docker, programId, sections) {
  const body = sections.map(([tag, command]) => `out=$(${command} 2>/dev/null) || out=; printf '%s %s\\n' ${tag} "$(printf '%s' "$out" | tr '\\n' '\\036')"`);
  return ["set -u", ...body, ""].join("\n").replaceAll("$DOCKER", docker).replaceAll("$PROGRAM", programId);
}

const inspect = (name) => `$DOCKER inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.Image}} {{.State.StartedAt}}' ${name}`;
const nodeStdin = (container, env, code) => `printf '%s' ${shellQuote(code)} | $DOCKER exec -i ${env} ${container} node --input-type=module -`;
const nodeEval = (container, code) => `$DOCKER exec ${container} node -e ${shellQuote(code)}`;
export const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

export function cumulusSections() {
  const c = CONTAINERS.contribution;
  return [
    ["palazzo", nodeStdin("palazzo", "-e PROGRAM_ID=$PROGRAM", PALAZZO_PROBE)],
    ["metrics", nodeStdin("alcantara-backend", "", METRICS_PROBE)],
    ["contribution", inspect(c.name)],
    ["contribution_blob", nodeEval(c.name, BLOB_PROBE(c.file))],
  ];
}
export function helixSections() {
  const c = CONTAINERS.return_runner;
  return [
    ["return_runner", inspect(c.name)],
    ["return_runner_blob", nodeEval(c.name, BLOB_PROBE(c.file))],
  ];
}

/** Tagged lines back to {tag: text}; an empty section is null. */
export function parseSections(stdout) {
  const sections = {};
  for (const row of String(stdout).split("\n")) {
    const space = row.indexOf(" ");
    if (space < 1) continue;
    const text = row.slice(space + 1).replaceAll("\u001e", "\n").trim();
    sections[row.slice(0, space)] = text || null;
  }
  return sections;
}

export function parseInspect(text, blob) {
  const [status, health, image, startedAt] = (text ?? "").split(" ");
  if (!status || !image) return null;
  return { status, health, image, startedAt, blob: /^[0-9a-f]{40}$/.test(blob ?? "") ? blob : null };
}

function run(command, args, { input, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd: ROOT, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(new Error(`${command} failed`)) : resolve(stdout),
    );
    if (input !== undefined) child.stdin.end(input);
  });
}
const ssh = (host, script) => run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "sh -s"], { input: script });
const attempt = async (read) => {
  try {
    return await read();
  } catch {
    return null;
  }
};
const now = () => new Date().toISOString();

async function changedSince(deployed, main, paths) {
  try {
    await run("git", ["diff", "--quiet", deployed, main, "--", ...paths]);
    return false;
  } catch {
    // Exit 1 is "changed"; a commit not known here is unread.
    return (await attempt(() => run("git", ["cat-file", "-e", `${deployed}^{commit}`]))) === null ? null : true;
  }
}

/** The newest commit on main whose copy of the file is this blob: what a container was built from. */
async function commitOfBlob(path, blob) {
  if (!blob) return null;
  const commits = (await attempt(() => run("git", ["log", "--format=%H", "-n", "200", "origin/main", "--", path]))) ?? "";
  for (const commit of commits.split("\n").filter(Boolean)) {
    const at = await attempt(() => run("git", ["rev-parse", `${commit}:${path}`]));
    if (at?.trim() === blob) return commit.slice(0, 8);
  }
  return null;
}

export async function main(env = process.env, out = console.log) {
  const api = (env.ALCANTARA_API_URL || "https://api.alcantara.gaulatti.com").replace(/\/$/, "");
  const app = (env.ALCANTARA_APP_URL || "https://alcantara.gaulatti.com").replace(/\/$/, "");
  const program = env.PROGRAM_ID || "modoitaliano.fm";
  const docker = env.STATUS_DOCKER || "docker";
  if (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(program) || !/^(sudo )?docker$/.test(docker)) {
    console.error("PROGRAM_ID must be a program id and STATUS_DOCKER docker or sudo docker");
    return 2;
  }
  let token = null;
  if (env.ALCANTARA_TOKEN_FILE) {
    try {
      token = readFileSync(env.ALCANTARA_TOKEN_FILE, "utf8").trim() || null;
    } catch {
      token = null;
    }
    if (!token) {
      console.error("ALCANTARA_TOKEN_FILE names no readable token");
      return 2;
    }
  }
  const ask = (tool, args) => (token ? attempt(() => mcp(api, token, tool, args)) : Promise.resolve(null));
  const noToken = token ? "" : " (no ALCANTARA_TOKEN_FILE)";

  await attempt(() => run("git", ["fetch", "--quiet", "origin", "main"]));
  const head = (await attempt(() => run("git", ["rev-parse", "origin/main"])))?.trim() || null;

  const [cumulus, helix, ready, index, frontendRun, health, onAir, chain, plan] = await Promise.all([
    attempt(() => ssh(env.CUMULUS_SSH || "cumulus.gaulatti.com", hostScript(docker, program, cumulusSections()))).then((s) => [parseSections(s ?? ""), now()]),
    attempt(() => ssh(env.HELIX_SSH || "helix.gaulatti.com", hostScript(docker, program, helixSections()))).then((s) => [parseSections(s ?? ""), now()]),
    attempt(async () => (await fetch(`${api}/health/ready`, { signal: AbortSignal.timeout(10_000) })).json()).then((v) => [v, now()]),
    attempt(async () => (await fetch(`${app}/`, { cache: "no-store", signal: AbortSignal.timeout(10_000) })).text()).then((v) => [v, now()]),
    attempt(async () =>
      JSON.parse(await run("gh", ["run", "list", "-R", env.GITHUB_REPO || "gaulatti/alcantara", "--workflow", "frontend-deploy.yml", "--branch", "main", "--status", "success", "-L", "1", "--json", "headSha,updatedAt"]))[0],
    ).then((v) => [v, now()]),
    ask("get_radio_health", { program_id: program }).then((v) => [v, now()]),
    ask("get_on_air", { program_id: program }).then((v) => [v, now()]),
    ask("call_capability", { name: "webrtc_health", arguments: { program_id: program } }).then((v) => [v, now()]),
    ask("call_capability", { name: "webrtc_host_mic_off", arguments: { program_id: program, dry_run: true, idempotency_key: `status-${Date.now()}` } }).then((v) => [v, now()]),
  ]);

  const [hostCumulus, atCumulus] = cumulus;
  const [hostHelix, atHelix] = helix;
  const palazzo = attemptJson(hostCumulus.palazzo);
  const metrics = hostCumulus.metrics ? parseMetrics(hostCumulus.metrics) : null;
  const hostMics = plan[0] ? (plan[0].affects ?? []).length : null;
  const mainBlobs = {};
  for (const [key, c] of Object.entries(CONTAINERS))
    mainBlobs[key] = (await attempt(() => run("git", ["rev-parse", `origin/main:${c.source}`])))?.trim() ?? null;
  const contribution = parseInspect(hostCumulus.contribution, hostCumulus.contribution_blob);
  const runner = parseInspect(hostHelix.return_runner, hostHelix.return_runner_blob);

  const backendBuild = typeof ready[0]?.build === "string" ? ready[0].build : null;
  const frontendSha = frontendRun[0]?.headSha ?? null;
  const manifest = /\/assets\/manifest-([A-Za-z0-9_-]+)\.js/.exec(index[0] ?? "")?.[1] ?? null;

  const rows = [
    radioAudible(palazzo, metrics, atCumulus),
    nextSongAccepted(onAir[0], onAir[1]),
    palazzoConnected(health[0], health[1]),
    callsHealth(chain[0], chain[1]),
    liveOffWithoutGuest(palazzo, metrics, hostMics, atCumulus),
    containerHealthy("contribution", contribution, mainBlobs.contribution, await commitOfBlob(CONTAINERS.contribution.source, contribution?.blob), atCumulus),
    containerHealthy("return_runner", runner, mainBlobs.return_runner, await commitOfBlob(CONTAINERS.return_runner.source, runner?.blob), atHelix),
    deployedCurrent("backend", backendBuild, head, backendBuild && head ? await changedSince(backendBuild, head, DEPLOY_PATHS.backend) : null, ready[1], ` lease=${ready[0]?.state ?? "unread"}`),
    deployedCurrent("frontend", frontendSha, head, frontendSha && head ? await changedSince(frontendSha, head, DEPLOY_PATHS.frontend) : null, frontendRun[1], ` last_green_deploy=${frontendRun[0]?.updatedAt ?? "unread"} served_manifest=${manifest ?? "unread"}`),
    legacyHostMicAbsent(plan[0], plan[1]),
  ].map((row) => (row.evidence.startsWith("not read: MCP") ? { ...row, evidence: row.evidence + noToken } : row));
  for (const row of rows) out(format(row));
  return rows.every((row) => row.ok === 1) ? 0 : 1;
}

function attemptJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main();
