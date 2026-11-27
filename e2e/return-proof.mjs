// Proof of the program return, from the guest's side only: a guest joins the real guest page and the level of the
// audio that page plays is measured. Nothing here opens a return router, a program feed or any other page.
//
// ALCANTARA_APP_URL, and either ALCANTARA_INVITATION_PATH (an operator admits the guest in the console) or
// ALCANTARA_API_URL with an operator token or local test auth (the script creates, admits and revokes).
// WEBRTC_BROWSER=chromium|firefox|webkit, RETURN_SECONDS (how long to listen, default 20),
// RETURN_EXPECT=sound|silence (silence: nothing else is in the room, so any sound would be the guest's own voice),
// ADMIT_SECONDS (how long to wait for admission, default the timeout), RETURN_DEVICE (a Playwright device name, such
// as "iPhone 15" or "Pixel 7": its viewport, user agent and touch), RETURN_LABEL (the run's name in the output),
// RETURN_ICE=tcp (Chromium only: WebRTC may not use plain UDP, as behind an office or hotel Wi-Fi that blocks it; the
// run then also fails if the pair it used was UDP) or RETURN_ICE=relay (as tcp, and only relayed paths are allowed,
// which is a network that leaves nothing but TURN: it must connect through a relay over TLS). The relay restriction is
// put on the page's connections here, by the harness; the product has no switch for it.
// return-proof-all.mjs runs the engines and the phones.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices, firefox, webkit } from "playwright";
import { SYNTHETIC_MEDIA } from "./synthetic-media.mjs";
import { PLAYING_COPY, waitForGuestCopy } from "./guest-copy.mjs";
import { describePath, failureReason, iceSatisfied, offeredCandidate, selectedPath } from "./ice-path.mjs";

const APP = (process.env.ALCANTARA_APP_URL || "http://localhost:5173").replace(/\/$/, "");
const API = (process.env.ALCANTARA_API_URL || "http://localhost:3000").replace(/\/$/, "");
const PROGRAM = process.env.ALCANTARA_PROGRAM_ID || "main";
const INVITATION = process.env.ALCANTARA_INVITATION_PATH || "";
const ENGINE = process.env.WEBRTC_BROWSER || "chromium";
const DEVICE = process.env.RETURN_DEVICE || "";
if (DEVICE && !devices[DEVICE]) throw new Error(`RETURN_DEVICE is not a Playwright device: ${DEVICE}`);
const LABEL = process.env.RETURN_LABEL || ENGINE;
const ICE = process.env.RETURN_ICE || "";
if (ICE && (!["tcp", "relay"].includes(ICE) || ENGINE !== "chromium")) throw new Error("RETURN_ICE takes tcp or relay, and only with Chromium.");
const SECONDS = Number(process.env.RETURN_SECONDS || 20);
const EXPECT = process.env.RETURN_EXPECT || "sound";
const TIMEOUT = Number(process.env.WEBRTC_TIMEOUT_MS || 60_000);
// With a production invitation an operator admits the guest by hand on /calls, which takes longer than a step.
const ADMIT_TIMEOUT = process.env.ADMIT_SECONDS ? Number(process.env.ADMIT_SECONDS) * 1000 : INVITATION ? Math.max(TIMEOUT, 180_000) : TIMEOUT;
/** Peak level, 0 to 1, above which the return is not silence. */
const AUDIBLE = 0.01;

/**
 * Runs in the guest page. Listens to whatever track the return element holds at each moment (the router may replace
 * it), and reads the receiver's own statistics. WebAudio alone is not enough: an engine with no sound device may never
 * start its context.
 */
async function measureReturn(seconds) {
  const element = () => [...document.querySelectorAll("audio")].find((a) => a.srcObject?.getAudioTracks().some((t) => t.readyState === "live"));
  const context = new AudioContext();
  await Promise.race([context.resume(), new Promise((resolve) => setTimeout(resolve, 3000))]).catch(() => undefined);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  const samples = new Float32Array(analyser.fftSize);
  const inbound = new Map();
  let source = null;
  let trackId = "";
  let tracksHeard = 0;
  let webAudioPeak = 0;
  let audibleReads = 0;
  let reads = 0;
  let playing = null;
  const round = (value) => Number((value ?? 0).toFixed(4));
  const readStats = async () => {
    for (const pc of window.__guestPcs ?? []) {
      if (pc.connectionState === "closed") continue;
      for (const stat of (await pc.getStats()).values()) {
        if (stat.type !== "inbound-rtp" || stat.kind !== "audio") continue;
        const key = stat.trackIdentifier || String(stat.ssrc);
        const seen = inbound.get(key) ?? { track: key, bytes: 0, packets: 0, audioLevelMax: 0, totalAudioEnergy: 0, attached: false };
        seen.bytes = stat.bytesReceived ?? 0;
        seen.packets = stat.packetsReceived ?? 0;
        seen.audioLevelMax = Math.max(seen.audioLevelMax, round(stat.audioLevel));
        seen.totalAudioEnergy = round(stat.totalAudioEnergy);
        seen.attached = seen.attached || key === trackId;
        inbound.set(key, seen);
      }
    }
  };
  for (const end = Date.now() + seconds * 1000; Date.now() < end; ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const audio = element();
    const track = audio?.srcObject.getAudioTracks().find((t) => t.readyState === "live");
    if (track && track.id !== trackId) {
      source?.disconnect();
      source = context.createMediaStreamSource(new MediaStream([track]));
      source.connect(analyser);
      trackId = track.id;
      tracksHeard += 1;
    }
    if (audio) playing = { paused: audio.paused, muted: audio.muted, volume: audio.volume, trackMuted: track?.muted ?? null };
    analyser.getFloatTimeDomainData(samples);
    let max = 0;
    for (const sample of samples) max = Math.max(max, Math.abs(sample));
    webAudioPeak = Math.max(webAudioPeak, max);
    reads += 1;
    if (max > 0.01) audibleReads += 1;
    if (reads % 5 === 0) await readStats();
  }
  await readStats();
  const receive = [...inbound.values()];
  const statsPeak = Math.max(0, ...receive.filter((r) => r.attached).map((r) => r.audioLevelMax));
  return {
    level: {
      peak: round(Math.max(webAudioPeak, statsPeak)),
      webAudioPeak: round(webAudioPeak),
      statsPeak,
      audibleShare: round(audibleReads / Math.max(reads, 1)),
      contextState: context.state,
      tracksHeard,
      element: playing,
    },
    receive,
  };
}

const report = (step, details = {}) => console.log(JSON.stringify({ step, at: new Date().toISOString(), ...details }));


async function api(path, { method = "GET", body, token } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

const token = INVITATION
  ? null
  : process.env.ALCANTARA_OPERATOR_TOKEN || (await api("/__test/session?identity=operator-a")).accessToken;
const invitation = INVITATION
  ? { id: null, invitationPath: INVITATION }
  : await api("/webrtc/invitations", {
      method: "POST",
      token,
      body: { programId: PROGRAM, displayName: "Synthetic return check", expiresInHours: 1, returnVideo: "none", returnAudioBus: "master" },
    });

const options = {
    chromium: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests",
        // No UDP unless a proxy carries it, and there is none: ICE over TCP or a TURN relay is all that is left.
        ...(ICE ? ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--webrtc-ip-handling-policy=disable_non_proxied_udp"] : []),
      ],
      ...(process.env.WEBRTC_EXECUTABLE ? { executablePath: process.env.WEBRTC_EXECUTABLE } : {}),
    },
    firefox: {
      firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true, "media.autoplay.default": 0 },
      // On macOS, Playwright's Firefox may find no profile folder under the real home.
      env: { ...process.env, CFFIXED_USER_HOME: mkdtempSync(join(tmpdir(), "return-proof-firefox-")) },
    },
    webkit: {},
}[ENGINE];
/** The pair each open connection of the guest page used. */
async function icePaths(page) {
  const connections = await page.evaluate(async () => {
    const seen = [];
    for (const pc of window.__guestPcs ?? []) {
      if (pc.connectionState === "closed") continue;
      seen.push({ state: pc.connectionState, ice: pc.iceConnectionState, reports: [...(await pc.getStats()).values()] });
    }
    return seen;
  });
  return connections.map(({ state, ice, reports }) => ({ state, ice, path: selectedPath(reports) }));
}
/** What the server offered over the whole run, closed connections included: types, protocols and ports only. */
async function offeredByServer(page) {
  const lines = await page.evaluate(() => window.__offered ?? []);
  return [...new Set(lines.map(offeredCandidate).filter(Boolean))];
}
/** The TURN servers the page was told about and the kinds of candidate it could gather itself. */
async function iceOfPage(page) {
  const { servers, gathered, attempts } = await page.evaluate(() => ({ servers: window.__iceServers ?? [], gathered: window.__gathered ?? [], attempts: window.__guestPcs?.length ?? 0 }));
  return {
    attempts,
    turnServers: [...new Set(servers.filter((url) => url.startsWith("turn")))],
    gathered: [...new Set(gathered.map(offeredCandidate).filter(Boolean).map((candidate) => candidate.replace(/ :\d+$/, "")))],
  };
}
let browser;
let guestPage = null;
let ok = false;
/** What the guest page shows when a step fails: its status text, the join controls and any help or error it gives. */
async function describeGuest(page) {
  if (!page) return {};
  return page
    .evaluate(() => {
      const buttonState = (pattern) => {
        const button = [...document.querySelectorAll("button")].find((b) => pattern.test(b.textContent || ""));
        return button ? (button.disabled ? "disabled" : "enabled") : "absent";
      };
      const text = (selector) => [...document.querySelectorAll(selector)].map((n) => (n.textContent || "").trim()).filter(Boolean).join(" | ").slice(0, 300);
      return {
        url: location.pathname,
        heading: text("h1"),
        status: text("header p, [role=status]"),
        alerts: text("[role=alert]"),
        speakerTest: buttonState(/Speaker test/),
        join: buttonState(/Join studio/),
        leave: buttonState(/Leave/),
        mediaDevices: Boolean(navigator.mediaDevices?.getUserMedia),
      };
    })
    .catch((reason) => ({ unreadable: String(reason?.message ?? reason).split("\n")[0] }));
}
try {
  browser = await { chromium, firefox, webkit }[ENGINE].launch(options);
  // A phone run takes the device's viewport, user agent, pixel ratio and touch.
  const { defaultBrowserType: _browserType, ...phone } = DEVICE ? devices[DEVICE] : {};
  const context = await browser.newContext({ ...phone, ...(ENGINE === "chromium" ? { permissions: ["camera", "microphone"] } : {}) });
  // A finger taps; a mouse clicks.
  const press = (locator, options) => (DEVICE ? locator.tap(options) : locator.click(options));
  // WebKit has no fake camera or microphone switch.
  if (ENGINE === "webkit") await context.addInitScript(SYNTHETIC_MEDIA);
  // The guest is signed out, as in production: the local test session is answered empty.
  await context.route("**/__test/session**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ accessToken: "", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), user: { sub: "", id: "", name: "", email: "" } }),
    }),
  );
  // Keeps the page's peer connections, to read what each one receives.
  await context.addInitScript((relayOnly) => {
    const restrict = (configuration) => (relayOnly ? { ...configuration, iceTransportPolicy: "relay" } : configuration);
    // The TURN servers the page was given (addresses only, never their credentials) and the candidates it gathered.
    window.__iceServers = [];
    window.__gathered = [];
    const noteServers = (configuration) => window.__iceServers.push(...(configuration?.iceServers ?? []).flatMap((server) => [server.urls].flat()));
    window.__guestPcs = [];
    // The server's candidates are noted as they arrive: a connection that fails is closed before anyone can ask it.
    window.__offered = [];
    window.RTCPeerConnection = class extends window.RTCPeerConnection {
      constructor(configuration, ...rest) {
        super(restrict(configuration), ...rest);
        noteServers(configuration);
        window.__guestPcs.push(this);
        this.addEventListener("icecandidate", (event) => event.candidate?.candidate && window.__gathered.push(event.candidate.candidate));
      }
      setConfiguration(configuration) {
        noteServers(configuration);
        return super.setConfiguration(restrict(configuration));
      }
      addIceCandidate(candidate, ...rest) {
        if (candidate?.candidate) window.__offered.push(candidate.candidate);
        return super.addIceCandidate(candidate, ...rest);
      }
      setRemoteDescription(description, ...rest) {
        window.__offered.push(...(description?.sdp ?? "").split("\n").filter((line) => line.startsWith("a=candidate:")));
        return super.setRemoteDescription(description, ...rest);
      }
    };
  }, ICE === "relay");
  const guest = await context.newPage();
  guestPage = guest;
  await guest.goto(`${APP}${invitation.invitationPath}`);
  await press(guest.getByRole("button", { name: /Speaker test/ }), { timeout: TIMEOUT });
  await guest.getByLabel(/I am wearing headphones/).check({ timeout: TIMEOUT });
  await press(guest.getByRole("button", { name: /Join studio/ }), { timeout: TIMEOUT });
  await guest.getByRole("button", { name: /Leave/ }).waitFor({ timeout: TIMEOUT });
  report("guest-joined", { ok: true, browser: LABEL, ...(DEVICE ? { device: DEVICE, viewport: guest.viewportSize() } : {}) });
  if (invitation.id) await api(`/webrtc/invitations/${encodeURIComponent(invitation.id)}/admit`, { method: "POST", token });
  else console.log(`WAITING FOR ADMIT ${LABEL}`);
  await guest.getByText(/mix-minus/).waitFor({ timeout: ADMIT_TIMEOUT });
  report("guest-admitted", { ok: true });
  // The return the page plays: the first audio element with a live track.
  const track = () =>
    guest.evaluate(() =>
      [...document.querySelectorAll("audio")].some((a) => a.srcObject?.getAudioTracks().some((t) => t.readyState === "live")),
    );
  const deadline = Date.now() + TIMEOUT;
  while (!(await track()) && Date.now() < deadline) await guest.waitForTimeout(500);
  const arrived = await track();
  report("return-track", { ok: arrived });
  // What the guest is told while the audio flows: the copy must say so, not "Connecting…" or the stall text.
  const copy = arrived ? await waitForGuestCopy(guest, PLAYING_COPY, 10_000) : null;
  const copyOk = arrived && copy === PLAYING_COPY;
  report("guest-copy", { ok: copyOk, expected: PLAYING_COPY, copy: copy ?? "none" });
  const { level, receive } = arrived ? await guest.evaluate(measureReturn, SECONDS) : { level: { peak: 0, webAudioPeak: 0, statsPeak: 0 }, receive: [] };
  // What arrived over the wire, whatever the page's audio graph can read.
  report("return-stats", { inbound: receive });
  const connections = await icePaths(guest);
  const used = connections.map((connection) => connection.path).filter(Boolean);
  const iceOk = iceSatisfied(ICE, used);
  report("ice-path", { ok: iceOk, used: [...new Set(used.map(describePath))], offered: await offeredByServer(guest), ...(await iceOfPage(guest)), connections });
  ok = arrived && copyOk && iceOk && (EXPECT === "silence" ? level.peak < AUDIBLE : level.peak >= AUDIBLE);
  report("return-level", { ok, expect: EXPECT, ...level });
  await press(guest.getByRole("button", { name: /Leave/ }));
  report("guest-left", { ok: true });
} catch (error) {
  // A run that cannot connect still says what the server offered and how far each connection got.
  const offered = guestPage ? await offeredByServer(guestPage).catch(() => []) : [];
  const own = guestPage ? await iceOfPage(guestPage).catch(() => null) : null;
  const timedOut = String(error?.message ?? error).split("\n")[0];
  report("error", { ok: false, error: failureReason(ICE, own, timedOut), page: await describeGuest(guestPage), offered, ...own });
} finally {
  await browser?.close();
  if (invitation.id) await api(`/webrtc/invitations/${encodeURIComponent(invitation.id)}`, { method: "DELETE", token }).catch(() => undefined);
}
process.exit(ok ? 0 : 1);
