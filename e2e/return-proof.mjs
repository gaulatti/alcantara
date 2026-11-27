// Proof of the program return, from the guest's side only: a guest joins the real guest page and the level of the
// audio that page plays is measured. Nothing here opens a return router, a program feed or any other page.
//
// ALCANTARA_APP_URL, and either ALCANTARA_INVITATION_PATH (an operator admits the guest in the console) or
// ALCANTARA_API_URL with an operator token or local test auth (the script creates, admits and revokes).
// WEBRTC_BROWSER=chromium|firefox|webkit, RETURN_SECONDS (how long to listen, default 20),
// RETURN_EXPECT=sound|silence (silence: nothing else is in the room, so any sound would be the guest's own voice),
// ADMIT_SECONDS (how long to wait for admission, default the timeout). return-proof-all.mjs runs the three engines.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit } from "playwright";
import { SYNTHETIC_MEDIA } from "./synthetic-media.mjs";

const APP = (process.env.ALCANTARA_APP_URL || "http://localhost:5173").replace(/\/$/, "");
const API = (process.env.ALCANTARA_API_URL || "http://localhost:3000").replace(/\/$/, "");
const PROGRAM = process.env.ALCANTARA_PROGRAM_ID || "main";
const INVITATION = process.env.ALCANTARA_INVITATION_PATH || "";
const ENGINE = process.env.WEBRTC_BROWSER || "chromium";
const SECONDS = Number(process.env.RETURN_SECONDS || 20);
const EXPECT = process.env.RETURN_EXPECT || "sound";
const TIMEOUT = Number(process.env.WEBRTC_TIMEOUT_MS || 60_000);
const ADMIT_TIMEOUT = process.env.ADMIT_SECONDS ? Number(process.env.ADMIT_SECONDS) * 1000 : TIMEOUT;
/** Peak level, 0 to 1, above which the return is not silence. */
const AUDIBLE = 0.01;

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
let browser;
let ok = false;
try {
  browser = await { chromium, firefox, webkit }[ENGINE].launch(options);
  const context = await browser.newContext(ENGINE === "chromium" ? { permissions: ["camera", "microphone"] } : {});
  // WebKit has no fake camera or microphone switch.
  if (ENGINE === "webkit") await context.addInitScript(SYNTHETIC_MEDIA);
  // The guest is signed out, as in production: the local test session is answered empty.
  await context.route("**/__test/session**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ accessToken: "", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), user: { sub: "", id: "", name: "", email: "" } }),
    }),
  );
  const guest = await context.newPage();
  await guest.goto(`${APP}${invitation.invitationPath}`);
  await guest.getByRole("button", { name: /Speaker test/ }).click({ timeout: TIMEOUT });
  await guest.getByLabel(/I am wearing headphones/).check({ timeout: TIMEOUT });
  await guest.getByRole("button", { name: /Join studio/ }).click({ timeout: TIMEOUT });
  await guest.getByRole("button", { name: /Leave/ }).waitFor({ timeout: TIMEOUT });
  report("guest-joined", { ok: true, browser: ENGINE });
  if (invitation.id) await api(`/webrtc/invitations/${encodeURIComponent(invitation.id)}/admit`, { method: "POST", token });
  else console.log(`WAITING FOR ADMIT ${ENGINE}`);
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
  const level = arrived
    ? await guest.evaluate(async (seconds) => {
        const element = [...document.querySelectorAll("audio")].find((a) => a.srcObject?.getAudioTracks().length);
        const context = new AudioContext();
        await context.resume();
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        context.createMediaStreamSource(element.srcObject).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        let peak = 0;
        let audibleReads = 0;
        let reads = 0;
        for (const end = Date.now() + seconds * 1000; Date.now() < end; ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          analyser.getFloatTimeDomainData(samples);
          let max = 0;
          for (const sample of samples) max = Math.max(max, Math.abs(sample));
          peak = Math.max(peak, max);
          reads += 1;
          if (max > 0.01) audibleReads += 1;
        }
        return { peak: Number(peak.toFixed(4)), audibleShare: Number((audibleReads / reads).toFixed(2)) };
      }, SECONDS)
    : { peak: 0, audibleShare: 0 };
  ok = arrived && (EXPECT === "silence" ? level.peak < AUDIBLE : level.peak >= AUDIBLE);
  report("return-level", { ok, expect: EXPECT, ...level });
  await guest.getByRole("button", { name: /Leave/ }).click();
  report("guest-left", { ok: true });
} catch (error) {
  report("error", { ok: false, error: String(error?.message ?? error).split("\n")[0] });
} finally {
  await browser?.close();
  if (invitation.id) await api(`/webrtc/invitations/${encodeURIComponent(invitation.id)}`, { method: "DELETE", token }).catch(() => undefined);
}
process.exit(ok ? 0 : 1);
