#!/usr/bin/env node
// What each external source type can do on the local stack (gaulatti/alcantara#51): does it warm up and become a
// usable logical input? One JSON line per source type, with "pass", "fail" or "not-built" and the numbers behind it.
//
//   caller          a guest joins, is admitted, and the operator receives its audio and video (webrtc-call.mjs);
//   alana-program   a participant with Alana's feed identity (`program-feed-<programId>`) publishes, and that same
//                   guest receives it as the program return. Alana itself is not run: only the consuming side;
//   hls, rtmp, whip, srt
//                   the source is created in the registry and watched for PROOF_WAIT_SECONDS: usable only if it
//                   reaches a previewable lifecycle with a participant identity;
//   mp4             there is no MP4 transport, and a video-stream scene refuses a URL;
//   srt-visible     the Sources page says SRT is not available.
//
// Local only: it signs in with test auth and mints the Alana participant's token with the Compose LiveKit key. It
// removes what it creates. It exits non-zero on a "fail"; "not-built" is a result, not a failure.
//
//   pnpm --filter @gaulatti/alcantara-e2e sources-proof
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const LIVEKIT_UMD = join(dirname(require.resolve("livekit-client")), "livekit-client.umd.js");
const API = (process.env.ALCANTARA_API_URL || "http://localhost:3000").replace(/\/$/, "");
const APP = (process.env.ALCANTARA_APP_URL || "http://localhost:5173").replace(/\/$/, "");
const LIVEKIT_URL = process.env.LIVEKIT_WS_URL || "ws://localhost:7880";
// The Compose stack's fixed local-only LiveKit key (compose.yml).
const LIVEKIT_KEY = "devkey";
const LIVEKIT_SECRET = "devsecret-devsecret-devsecret-devsecret";
const PROGRAM = process.env.ALCANTARA_PROGRAM_ID || "radio-demo.fm";
const WAIT = Number(process.env.PROOF_WAIT_SECONDS || 20);

for (const url of [API, APP, LIVEKIT_URL])
  if (!/^(https?|wss?):\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)) {
    console.error("This proof runs against a local stack only.");
    process.exit(2);
  }

const results = [];
const report = (source, result, details = {}) => {
  results.push(result);
  console.log(JSON.stringify({ source, result, ...details }));
};

let token;
async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  return { status: response.status, json };
}

function feedToken(identity, room) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${part({ alg: "HS256", typ: "JWT" })}.${part({
    iss: LIVEKIT_KEY,
    sub: identity,
    nbf: now - 5,
    exp: now + 300,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: false },
  })}`;
  return `${body}.${createHmac("sha256", LIVEKIT_SECRET).update(body).digest("base64url")}`;
}

/** The caller and the Alana feed in one call: the script's own checks do the caller, this publishes the feed. */
async function callerAndAlanaFeed(browser) {
  const identity = `program-feed-${PROGRAM}`;
  // With a camera permission Chromium shows its addresses; without one LiveKit on this machine gets no media path.
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  const page = await context.newPage();
  await page.route(`${APP}/__proof`, (route) => route.fulfill({ contentType: "text/html", body: "<canvas id=c width=640 height=360></canvas>" }));
  await page.goto(`${APP}/__proof`);
  await page.addScriptTag({ path: LIVEKIT_UMD });
  await page.evaluate(
    async ([url, jwt]) => {
      const { Room, Track } = window.LivekitClient;
      const room = new Room();
      await room.connect(url, jwt);
      const canvas = document.getElementById("c");
      const context = canvas.getContext("2d");
      let frame = 0;
      setInterval(() => {
        context.fillStyle = `hsl(${(frame += 7) % 360} 70% 45%)`;
        context.fillRect(0, 0, 640, 360);
      }, 40);
      const [video] = canvas.captureStream(25).getVideoTracks();
      await room.localParticipant.publishTrack(video, { source: Track.Source.Camera, name: "program" });
      window.__room = room;
    },
    [LIVEKIT_URL, feedToken(identity, `alcantara-${PROGRAM}`)],
  );
  const lines = [];
  const started = Date.now();
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "webrtc-call.mjs")], {
      env: { ...process.env, ALCANTARA_API_URL: API, ALCANTARA_APP_URL: APP, ALCANTARA_PROGRAM_ID: PROGRAM, WEBRTC_SYNTHETIC_FEED: "0" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let pending = "";
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const parts = pending.split("\n");
      pending = parts.pop();
      for (const line of parts) if (line.startsWith("{")) lines.push(JSON.parse(line));
    });
    child.on("close", resolve);
  });
  await page.evaluate(() => window.__room.disconnect());
  await context.close();
  const step = (name) => lines.find((line) => line.step === name);
  const since = (name) => (step(name) ? Math.round((Date.parse(step(name).at) - Date.parse(step("invitation").at)) / 100) / 10 : null);
  const operator = step("operator-receives-guest");
  report("caller", operator?.ok ? "pass" : "fail", {
    joinedSeconds: since("guest-joined"),
    receivedByOperatorSeconds: since("operator-receives-guest"),
    audioBytes: operator?.audioBytes ?? 0,
    videoBytes: operator?.videoBytes ?? 0,
    runSeconds: Math.round((Date.now() - started) / 1000),
    ...(code === 0 ? {} : { error: step("error")?.error?.slice(0, 200) }),
  });
  report("alana-program", step("guest-receives-return")?.ok ? "pass" : "fail", {
    identity,
    receivedByGuestSeconds: since("guest-receives-return"),
    note: "consuming side only; Alana is not run",
  });
}

async function registrySource(transport, transportConfig) {
  const created = await api("/external-sources", {
    method: "POST",
    body: { name: `proof ${transport} ${randomUUID().slice(0, 8)}`, transport, transportConfig, programIds: [PROGRAM, "main"] },
  });
  if (created.status >= 300) {
    report(transport, "fail", { createStatus: created.status, message: created.json?.message });
    return null;
  }
  const { id } = created.json;
  const started = Date.now();
  let seen = created.json;
  while (Date.now() - started < WAIT * 1000) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    seen = (await api(`/external-sources/${id}`)).json;
    if (seen.participantIdentity) break;
  }
  const usable = ["connected", "degraded", "reconnecting"].includes(seen.lifecycle) && Boolean(seen.participantIdentity);
  report(transport, usable ? "pass" : "not-built", {
    createStatus: created.status,
    lifecycle: seen.lifecycle,
    participantIdentity: seen.participantIdentity,
    watchedSeconds: Math.round((Date.now() - started) / 1000),
    ...(usable ? {} : { note: "stored in the registry; nothing ingests it" }),
  });
  return id;
}

async function mp4() {
  const asTransport = await api("/external-sources", {
    method: "POST",
    body: { name: "proof mp4", transport: "mp4", transportConfig: { url: "https://example.com/clip.mp4" }, programIds: [PROGRAM] },
  });
  if (asTransport.status < 300) await api(`/external-sources/${asTransport.json.id}`, { method: "DELETE" });
  report("mp4", asTransport.status >= 400 ? "not-built" : "fail", {
    createStatus: asTransport.status,
    message: asTransport.json?.message,
    note: "no MP4 transport; a video-stream scene takes a registry source, never a URL",
  });
}

async function srtVisible(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // The page lists the selected program's sources, which is `main` until an operator picks another.
  await page.goto(`${APP}/sources`);
  const shown = await page
    .getByText("SRT is not available yet")
    .first()
    .waitFor({ timeout: 60_000 })
    .then(() => true)
    .catch(() => false);
  report("srt-visible", shown ? "pass" : "fail", { page: "/sources" });
  await page.close();
}

async function main() {
  token = (await api("/__test/session?identity=operator-a")).json.accessToken;
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests"],
  });
  const created = [];
  try {
    await callerAndAlanaFeed(browser);
    // The pull sources need a public HTTPS or SRT name to be accepted; nothing is fetched from it.
    created.push(await registrySource("hls", { url: "https://example.com/live/index.m3u8" }));
    created.push(await registrySource("rtmp", {}));
    created.push(await registrySource("whip", {}));
    created.push(await registrySource("srt", { url: "srt://example.com:9000" }));
    await mp4();
    await srtVisible(browser);
  } finally {
    for (const id of created.filter(Boolean)) await api(`/external-sources/${id}`, { method: "DELETE" });
    await browser.close();
  }
  process.exitCode = results.includes("fail") ? 1 : 0;
}

main().catch((error) => {
  console.log(JSON.stringify({ source: "run", result: "fail", error: String(error?.message ?? error).slice(0, 300) }));
  process.exitCode = 1;
});
