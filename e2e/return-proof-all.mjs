// The program return proof in Chromium, WebKit and Firefox, then as an iPhone and as an Android phone, one after
// another, then the return router's own lines. RETURN_RUNS (a comma list of run names) runs only those.
//
//   ALCANTARA_INVITATION_PATH=/guest/<token> node return-proof-all.mjs
//
// With an invitation, an operator presses Admit in /calls each time "WAITING FOR ADMIT <browser>" is printed (180 s).
// With ALCANTARA_OPERATOR_TOKEN instead, each run creates, admits and revokes its own invitation for
// ALCANTARA_PROGRAM_ID. Defaults to production and modoitaliano.fm. Exits 0 only when every run heard something.
// RETURN_RUNNER_SSH (default helix.gaulatti.com) is where the runner's log is read; empty skips it.
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const RUNS = [
  { name: "chromium", engine: "chromium" },
  { name: "webkit", engine: "webkit" },
  { name: "firefox", engine: "firefox" },
  // Most guests join from a phone: its viewport, user agent and touch, on the engine that phone uses.
  { name: "iphone", engine: "webkit", device: "iPhone 15" },
  { name: "android", engine: "chromium", device: "Pixel 7" },
  // An office or hotel Wi-Fi that blocks UDP: media has to go over TCP or a relay.
  { name: "chromium-tcp", engine: "chromium", ice: "tcp" },
  // A network that leaves only TCP 443: nothing but TURN over TLS can carry the call. Run it by name: it fails until
  // that is set up (infra/README.md, "TURN over TLS").
  { name: "chromium-relay", engine: "chromium", ice: "relay", onRequest: true },
];

/** The runs asked for by name, or all but the ones that are only run by name. */
export function selectRuns(names = "") {
  const wanted = names.split(",").map((name) => name.trim()).filter(Boolean);
  const unknown = wanted.filter((name) => !RUNS.some((run) => run.name === name));
  if (unknown.length) throw new Error(`unknown runs: ${unknown.join(", ")}`);
  return wanted.length ? RUNS.filter((run) => wanted.includes(run.name)) : RUNS.filter((run) => !run.onRequest);
}
/** A guest session keeps the invitation for 60 s after the guest leaves; the next browser waits it out. */
const SESSION_PAUSE_SECONDS = 70;
/** No engine may hold the run: one that hangs is stopped and reported. */
const BROWSER_LIMIT_MS = 6 * 60_000;

/** One browser's result from the proof's JSON lines. */
export function outcome(browser, lines) {
  const steps = {};
  let error = "";
  let offered = "";
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.step === "error") {
      error = entry.error;
      offered = entry.offered?.join(", ") ?? "";
    } else if (entry.step) steps[entry.step] = entry;
  }
  return {
    browser,
    joined: steps["guest-joined"]?.ok === true,
    admitted: steps["guest-admitted"]?.ok === true,
    track: steps["return-track"]?.ok === true,
    copy: steps["guest-copy"]?.copy ?? "none",
    copyOk: steps["guest-copy"]?.ok === true,
    peak: steps["return-level"]?.peak ?? 0,
    ice: steps["ice-path"]?.used?.join(", ") ?? "",
    iceOk: steps["ice-path"]?.ok !== false,
    offered,
    error,
  };
}

export function summaryLine({ browser, joined, admitted, track, copy = "none", copyOk = false, peak, ice = "", iceOk = true, offered = "", error }) {
  const yes = (value) => (value ? "yes" : "NO");
  const quiet = peak > 0 && peak < 0.01 ? " (below the 0.01 audible level)" : "";
  const copyNote = track ? `, guest copy "${copy}"${copyOk ? "" : " (NOT playing while audio flows)"}` : "";
  return `${browser}: joined ${yes(joined)}, admitted ${yes(admitted)}, return track ${yes(track)}, return peak ${peak}${quiet}${copyNote}${ice ? `, path: ${ice}${iceOk ? "" : " (not the path this run demands)"}` : ""}${error ? `, error: ${error}` : ""}${error && offered ? `, server offered: ${offered}` : ""}`;
}

export const passed = (results, runs = selectRuns().length) => results.length === runs && results.every((r) => r.track && r.peak > 0 && r.copyOk && r.iceOk !== false);

/** The last 40 lines the router page wrote. */
export const routerLines = (log) => log.split("\n").filter((line) => line.includes("[return-router] ")).slice(-40);

function runBrowser(run, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "return-proof.mjs")], {
      env: { ...env, WEBRTC_BROWSER: run.engine, RETURN_DEVICE: run.device ?? "", RETURN_ICE: run.ice ?? "", RETURN_LABEL: run.name },
      stdio: ["ignore", "pipe", "inherit"],
      timeout: BROWSER_LIMIT_MS,
      killSignal: "SIGKILL",
    });
    const lines = [];
    createInterface({ input: child.stdout }).on("line", (line) => {
      lines.push(line);
      console.log(line);
    });
    child.on("close", () => resolve(outcome(run.name, lines)));
  });
}

async function main() {
  const token = process.env.ALCANTARA_OPERATOR_TOKEN;
  if (!token && !process.env.ALCANTARA_INVITATION_PATH) {
    console.error("Set ALCANTARA_INVITATION_PATH (an invitation made in /calls) or ALCANTARA_OPERATOR_TOKEN.");
    process.exit(2);
  }
  const env = {
    ALCANTARA_APP_URL: "https://alcantara.gaulatti.com",
    ALCANTARA_API_URL: "https://api.alcantara.gaulatti.com",
    ALCANTARA_PROGRAM_ID: "modoitaliano.fm",
    RETURN_SECONDS: "30",
    ADMIT_SECONDS: "180",
    ...process.env,
  };
  // With a token each run makes its own invitation.
  if (token) delete env.ALCANTARA_INVITATION_PATH;
  const pause = Number(process.env.RETURN_PAUSE_SECONDS ?? SESSION_PAUSE_SECONDS);
  const started = new Date().toISOString();
  const results = [];
  const runs = selectRuns(process.env.RETURN_RUNS);
  for (const run of runs) {
    if (results.length && !token && pause > 0) {
      console.log(`Waiting ${pause} s for the previous guest session to expire`);
      await new Promise((resolve) => setTimeout(resolve, pause * 1000));
    }
    console.log(`--- ${run.name}${run.device ? ` (${run.device}, ${run.engine})` : ""}`);
    results.push(await runBrowser(run, env));
  }
  const host = process.env.RETURN_RUNNER_SSH ?? "helix.gaulatti.com";
  if (host) {
    console.log(`--- last [return-router] lines from alcantara-return-runner on ${host}`);
    try {
      // The host's login shell may be fish, so the command runs in sh.
      const { stdout } = await promisify(execFile)(
        "ssh",
        ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, `sh -c 'docker logs --timestamps --since ${started} alcantara-return-runner 2>&1'`],
        { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
      );
      const lines = routerLines(stdout);
      console.log(lines.length ? lines.join("\n") : "(none since this run started)");
    } catch (error) {
      console.log(`(skipped: ${host} cannot be reached from here: ${String(error.message).split("\n")[0]})`);
    }
  }
  console.log("--- summary");
  for (const result of results) console.log(summaryLine(result));
  process.exit(passed(results, runs.length) ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
