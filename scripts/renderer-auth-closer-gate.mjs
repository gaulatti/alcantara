#!/usr/bin/env node
// The gate for the renderer-key closer (gaulatti/alcantara#884): exits 0 only when, for the last 24 hours, no call or
// renderer write was let in with the old shared key or with no credential, the evidence for that is whole, and the
// runtime secret holds the fleet key the return runner needs once the shared key is gone. Read only.
//
//   node scripts/renderer-auth-closer-gate.mjs
//
// One line per claim, `<1|0> <name> <ISO time> <evidence>`, as scripts/production-status.mjs prints. A claim that could
// not be read, or whose answer is empty, partial or an error, is 0. Exit 0 when every line is 1, 1 when any is 0.
//
// PROMQL_CMD runs one instant query against Milano's Prometheus and prints its JSON answer; `{query}` in it is replaced
// by the URL-encoded query. SECRET_STATUS_CMD prints backend/scripts/renderer-secret-status.mjs's one line, which names
// the keys the secret holds and never a value. Both run with `sh -c`; the defaults are below.
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DEFAULT_PROMQL_CMD =
  "ssh -o BatchMode=yes helix.gaulatti.com \"docker exec milano-prometheus-1 wget -qO- 'http://localhost:9090/api/v1/query?query={query}'\"";
export const DEFAULT_SECRET_STATUS_CMD =
  'docker run --rm -e AWS_REGION -e ALCANTARA_CONFIG_SECRET_ID ${AWS_PROFILE:+-e AWS_PROFILE} -v "$HOME/.aws:/root/.aws:ro" ghcr.io/gaulatti/alcantara:latest node scripts/renderer-secret-status.mjs';

const METRIC = "alcantara_webrtc_renderer_auth_total";
/** The accepted checks the closer removes. Zero over the window is the claim. */
export const FALLBACK_ACCEPTED = `sum(increase(${METRIC}{credential=~"shared|none",result="accepted"}[24h]))`;
/** The metric already existed at the start of the window, so the window is not shorter than it says. */
export const PRESENT_AT_START = `count(${METRIC} offset 24h)`;
/** The scrape targets that carry the metric now. */
export const TARGETS = `count by (job, instance) (${METRIC})`;
/** Each target's scrape over the window: its worst `up`, its scrapes over 24 h, and its scrapes in the last hour. */
export const targetQueries = ({ job, instance }) => {
  const selector = `up{job=${JSON.stringify(job)},instance=${JSON.stringify(instance)}}`;
  return {
    worst: `min_over_time(${selector}[24h])`,
    day: `count_over_time(${selector}[24h])`,
    hour: `count_over_time(${selector}[1h])`,
  };
};
/** A day's scrapes must be at least this many hours' worth at the last hour's rate, so no scrape gap hides a use. */
export const MIN_SCRAPED_HOURS = 23.5;

/** The URL-encoded query, with the characters a shell's single quotes or a URL would read encoded too. */
export const encodeQuery = (query) => encodeURIComponent(query).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** A Prometheus answer's vector, or null for anything that is not a successful vector. */
export function vectorOf(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (body?.status !== "success" || body?.data?.resultType !== "vector" || !Array.isArray(body.data.result)) return null;
  if (Array.isArray(body.warnings) && body.warnings.length) return null;
  const rows = [];
  for (const row of body.data.result) {
    const value = Number(row?.value?.[1]);
    if (!row || typeof row.metric !== "object" || !Number.isFinite(value)) return null;
    rows.push({ metric: row.metric, value });
  }
  return rows;
}

/** The single value of a one-row vector, or null. */
const single = (rows) => (rows && rows.length === 1 ? rows[0].value : null);

/**
 * The claims, from `query(promql)` (the JSON text, or null when it could not run) and `secretStatus()` (the status
 * line, or null). Each claim is `{ ok, name, evidence }`.
 */
export async function gate({ query, secretStatus }) {
  const ask = async (promql) => vectorOf((await query(promql)) ?? "");
  const claims = [];

  const accepted = single(await ask(FALLBACK_ACCEPTED));
  claims.push({
    ok: accepted === 0,
    name: "fallback_unused_24h",
    evidence: accepted === null ? "not read: no single answer" : `shared or no-credential acceptances in 24 h: ${accepted}`,
  });

  const present = single(await ask(PRESENT_AT_START));
  claims.push({
    ok: present !== null && present > 0,
    name: "window_whole",
    evidence: present === null ? "not read: the metric had no series 24 h ago" : `series 24 h ago: ${present}`,
  });

  const targets = await ask(TARGETS);
  const scraped = [];
  let scrapeOk = Array.isArray(targets) && targets.length > 0;
  for (const target of targets ?? []) {
    const { job, instance } = target.metric;
    if (typeof job !== "string" || typeof instance !== "string") {
      scrapeOk = false;
      continue;
    }
    const q = targetQueries({ job, instance });
    const worst = single(await ask(q.worst));
    const day = single(await ask(q.day));
    const hour = single(await ask(q.hour));
    const whole = worst === 1 && day !== null && hour !== null && hour > 0 && day >= MIN_SCRAPED_HOURS * hour;
    if (!whole) scrapeOk = false;
    scraped.push(`${job}/${instance} up_min=${worst ?? "?"} scrapes_24h=${day ?? "?"} scrapes_1h=${hour ?? "?"}`);
  }
  claims.push({
    ok: scrapeOk,
    name: "scrape_whole_24h",
    evidence: targets === null ? "not read: no answer" : targets.length ? scraped.join("; ") : "not read: no target carries the metric",
  });

  let status = null;
  try {
    const line = await secretStatus();
    status = line ? JSON.parse(line) : null;
  } catch {
    status = null;
  }
  const fleet = status && typeof status === "object" ? status.fleetKey === true : null;
  claims.push({
    ok: fleet === true,
    name: "fleet_key_in_secret",
    evidence: fleet === null ? "not read: no secret status" : fleet ? "present" : "absent",
  });
  return claims;
}

export const format = (claim, at) => `${claim.ok ? 1 : 0} ${claim.name} ${at} ${claim.evidence}`;

function sh(command, timeout = 60_000) {
  return new Promise((resolve) => {
    execFile("sh", ["-c", command], { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout));
  });
}

export async function main(env = process.env, { run = sh, print = console.log, now = () => new Date().toISOString() } = {}) {
  const promql = env.PROMQL_CMD || DEFAULT_PROMQL_CMD;
  if (!promql.includes("{query}")) {
    console.error("PROMQL_CMD must contain {query}");
    return 2;
  }
  const claims = await gate({
    query: (q) => run(promql.replaceAll("{query}", encodeQuery(q))),
    secretStatus: () => run(env.SECRET_STATUS_CMD || DEFAULT_SECRET_STATUS_CMD),
  });
  const at = now();
  for (const claim of claims) print(format(claim, at));
  return claims.every((claim) => claim.ok) ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main();
