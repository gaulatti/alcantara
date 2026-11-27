// The gate for removing the older-console host-mic rule (gaulatti/alcantara#880): 24 hours with no onair:host from an
// ordinary operator connection, since the one-host-mic rollout. Read-only: it only reads log files already pulled.
//
// Usage: node scripts/host-mic-gate.mjs --livekit livekit.log --livekit-created <ISO> [--worker worker.log]
//   livekit.log: `docker logs alcantara-livekit` lines containing "mediaTrack published" (Helix)
//   --livekit-created: `docker inspect -f {{.Created}} alcantara-livekit`; its logs must reach back to the window
//   worker.log: `docker logs --timestamps alcantara-contribution` lines containing "track subscribed" (cumulus)
//
// LiveKit does not log track names, so any audio an ordinary operator connection published counts against the gate,
// talkback included: such a line is printed to be looked at. The worker's lines name the track and settle it.
// Prints one line per claim, `<name> 1|0 <evidence>`; exits 0 only when the gate is met.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const ROLLOUT = "2026-11-27T12:29:00Z";
export const WINDOW_MS = 24 * 3600 * 1000;

const ordinaryOperator = (identity) => identity.startsWith("operator-") && !identity.startsWith("operator-host-mic-");

/** Audio published by an ordinary operator connection, and how many publish lines of any kind were read. */
export function livekitEvents(text) {
  const events = [];
  let read = 0;
  for (const line of text.split("\n")) {
    if (!line.includes("mediaTrack published")) continue;
    const at = Date.parse(line.split(/\s/)[0]);
    const identity = /"participant": ?"([^"]*)"/.exec(line)?.[1];
    const kind = /"kind": ?"([^"]*)"/.exec(line)?.[1];
    if (!Number.isFinite(at) || identity === undefined || kind === undefined) throw new Error("unreadable LiveKit publish line");
    read += 1;
    if (kind === "audio" && ordinaryOperator(identity)) events.push({ at, identity, source: "livekit" });
  }
  return { events, read };
}

/** The worker's own sightings of an ordinary operator connection's onair:host. */
export function workerEvents(text) {
  const events = [];
  let read = 0;
  for (const line of text.split("\n")) {
    if (!line.includes('"track subscribed"')) continue;
    const at = Date.parse(line.split(/\s/)[0]);
    const body = JSON.parse(line.slice(line.indexOf("{")));
    if (!Number.isFinite(at) || typeof body.identity !== "string") throw new Error("a worker line without a timestamp: pull with --timestamps");
    read += 1;
    if (body.track === "onair:host" && ordinaryOperator(body.identity)) events.push({ at, identity: body.identity, source: "worker" });
  }
  return { events, read };
}

/** The gate: the logs reach back over the whole window, and 24 hours have passed since the rollout and any sighting. */
export function gate({ livekit, worker, livekitCreated, now }) {
  const rollout = Date.parse(ROLLOUT);
  const created = Date.parse(livekitCreated);
  const seen = [...livekit.events, ...worker.events].filter((event) => event.at >= rollout).sort((a, b) => a.at - b.at);
  const earliest = Math.max(rollout, ...seen.map((event) => event.at)) + WINDOW_MS;
  const covered = Number.isFinite(created) && created <= rollout;
  const iso = (ms) => new Date(ms).toISOString();
  return {
    ok: covered && now >= earliest,
    rows: [
      ["livekit_logs_cover_window", covered, `container_created=${livekitCreated} rollout=${ROLLOUT} publish_lines=${livekit.read}`],
      ["no_legacy_host_mic_since_rollout", seen.length === 0, `sightings=${seen.length} worker_track_lines=${worker.read}` + seen.map((e) => ` [${iso(e.at)} ${e.source} ${e.identity}]`).join("")],
      ["24h_clear", now >= earliest, `earliest_merge=${iso(earliest)} now=${iso(now)}`],
    ],
  };
}

function main(argv) {
  const option = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const livekitFile = option("--livekit");
  const created = option("--livekit-created");
  if (!livekitFile || !created) {
    console.error("usage: node scripts/host-mic-gate.mjs --livekit <file> --livekit-created <ISO> [--worker <file>]");
    return 2;
  }
  const workerFile = option("--worker");
  const result = gate({
    livekit: livekitEvents(readFileSync(livekitFile, "utf8")),
    worker: workerEvents(workerFile ? readFileSync(workerFile, "utf8") : ""),
    livekitCreated: created,
    now: Date.now(),
  });
  for (const [name, ok, evidence] of result.rows) console.log(`${name} ${ok ? 1 : 0} ${evidence}`);
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
