// The program return proof in Chromium, WebKit and Firefox, one after another, then the return router's own lines.
//
//   ALCANTARA_INVITATION_PATH=/guest/<token> node return-proof-all.mjs
//
// With an invitation, an operator presses Admit in /calls each time "WAITING FOR ADMIT <browser>" is printed (120 s).
// With ALCANTARA_OPERATOR_TOKEN instead, each run creates, admits and revokes its own invitation for
// ALCANTARA_PROGRAM_ID. Defaults to production and modoitaliano.fm. Exits 0 only when all three heard something.
// RETURN_RUNNER_SSH (default helix.gaulatti.com) is where the runner's log is read; empty skips it.
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const BROWSERS = ["chromium", "webkit", "firefox"];
/** A guest session keeps the invitation for 60 s after the guest leaves; the next browser waits it out. */
const SESSION_PAUSE_SECONDS = 70;

/** One browser's result from the proof's JSON lines. */
export function outcome(browser, lines) {
  const steps = {};
  let error = "";
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.step === "error") error = entry.error;
    else if (entry.step) steps[entry.step] = entry;
  }
  return {
    browser,
    joined: steps["guest-joined"]?.ok === true,
    admitted: steps["guest-admitted"]?.ok === true,
    track: steps["return-track"]?.ok === true,
    peak: steps["return-level"]?.peak ?? 0,
    error,
  };
}

export function summaryLine({ browser, joined, admitted, track, peak, error }) {
  const yes = (value) => (value ? "yes" : "NO");
  const quiet = peak > 0 && peak < 0.01 ? " (below the 0.01 audible level)" : "";
  return `${browser}: joined ${yes(joined)}, admitted ${yes(admitted)}, return track ${yes(track)}, return peak ${peak}${quiet}${error ? `, error: ${error}` : ""}`;
}

export const passed = (results) => results.length === BROWSERS.length && results.every((r) => r.track && r.peak > 0);

/** The last 40 lines the router page wrote. */
export const routerLines = (log) => log.split("\n").filter((line) => line.includes("[return-router] ")).slice(-40);

function runBrowser(browser, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "return-proof.mjs")], {
      env: { ...env, WEBRTC_BROWSER: browser },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const lines = [];
    createInterface({ input: child.stdout }).on("line", (line) => {
      lines.push(line);
      console.log(line);
    });
    child.on("close", () => resolve(outcome(browser, lines)));
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
    ADMIT_SECONDS: "120",
    ...process.env,
  };
  // With a token each run makes its own invitation.
  if (token) delete env.ALCANTARA_INVITATION_PATH;
  const pause = Number(process.env.RETURN_PAUSE_SECONDS ?? SESSION_PAUSE_SECONDS);
  const started = new Date().toISOString();
  const results = [];
  for (const browser of BROWSERS) {
    if (results.length && !token && pause > 0) {
      console.log(`Waiting ${pause} s for the previous guest session to expire`);
      await new Promise((resolve) => setTimeout(resolve, pause * 1000));
    }
    console.log(`--- ${browser}`);
    results.push(await runBrowser(browser, env));
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
  process.exit(passed(results) ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
