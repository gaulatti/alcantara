// Proof that a guest cued live is on the radio's public air, and off it once wrapped.
//
//   ALCANTARA_INVITATION_PATH=/guest/<token> node onair-proof.mjs
//
// A guest joins the real guest page publishing a steady tone. An operator presses Admit and then cues them live on
// /calls, and later wraps them. The script listens to the public stream itself, decodes it, and measures the tone
// against the frequencies beside it. It exits 0 only if the tone was not there before, was there while the guest was
// live, and was gone after the wrap. THE TONE GOES ON THE REAL AIR: run it in an agreed window.
//
// ALCANTARA_APP_URL (default production), ONAIR_STREAM_URL (default https://radio.modoitaliano.fm/stream),
// TONE_HZ (1000), TONE_GAIN (0.2, about -14 dBFS at the source), LISTEN_SECONDS (20).
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const APP = (process.env.ALCANTARA_APP_URL || "https://alcantara.gaulatti.com").replace(/\/$/, "");
const STREAM = process.env.ONAIR_STREAM_URL || "https://radio.modoitaliano.fm/stream";
const INVITATION = process.env.ALCANTARA_INVITATION_PATH || "";
const HZ = Number(process.env.TONE_HZ || 1000);
const GAIN = Number(process.env.TONE_GAIN || 0.2);
const LISTEN = Number(process.env.LISTEN_SECONDS || 20);
/** Icecast sends a new listener a burst of past audio at once; what arrives in this time is discarded. */
const BURST_MS = 2_000;
const WINDOW_SECONDS = 0.5;
/** A window holds the tone when it stands this far above its neighbours and is not just a trace. */
const RATIO_DB = 25;
const FLOOR_DBFS = -40;
const NEIGHBOURS = [-80, -60, -40, 40, 60, 80];

/** Amplitude of one frequency in a Hann-windowed block (Goertzel), 1 being full scale. */
function amplitude(block, rate, hz) {
  const coefficient = 2 * Math.cos((2 * Math.PI * hz) / rate);
  let one = 0;
  let two = 0;
  for (let i = 0; i < block.length; i += 1) {
    const windowed = block[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (block.length - 1)));
    const value = windowed + coefficient * one - two;
    two = one;
    one = value;
  }
  return (Math.sqrt(Math.max(one * one + two * two - coefficient * one * two, 0)) * 4) / block.length;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const db = (value) => 20 * Math.log10(Math.max(value, 1e-9));

/** How much of the audio carries the tone. `samples` are mono, -1 to 1. */
export function toneReport(samples, rate, hz) {
  const size = Math.round(rate * WINDOW_SECONDS);
  const ratios = [];
  const levels = [];
  let withTone = 0;
  for (let start = 0; start + size <= samples.length; start += size) {
    const block = samples.subarray(start, start + size);
    const level = db(amplitude(block, rate, hz));
    const ratio = level - db(median(NEIGHBOURS.map((offset) => amplitude(block, rate, hz + offset))));
    ratios.push(ratio);
    levels.push(level);
    if (ratio >= RATIO_DB && level >= FLOOR_DBFS) withTone += 1;
  }
  const windows = ratios.length;
  const share = windows ? withTone / windows : 0;
  const one = (value) => Math.round(value * 10) / 10;
  return {
    windows,
    withTone,
    share: Math.round(share * 100) / 100,
    toneDbfs: windows ? one(median(levels)) : null,
    aboveNeighboursDb: windows ? one(median(ratios)) : null,
    present: windows > 0 && share >= 0.8,
    absent: windows > 0 && share <= 0.1,
  };
}

/** The proof's verdict from its three measurements and the guest page's two banner checks. */
export const proven = (before, live, after, guestPage = {}) =>
  Boolean(before?.absent && live?.present && after?.absent && guestPage.liveShown === true && guestPage.offShown === true);

/** Whether the guest page shows this exact banner text within the time allowed. */
const bannerShown = (page, text, timeout = 5_000) =>
  page
    .getByText(text, { exact: true })
    .waitFor({ timeout })
    .then(() => true, () => false);

const report = (step, details = {}) => console.log(JSON.stringify({ step, at: new Date().toISOString(), ...details }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `seconds` of the stream as it is broadcast now. */
export async function capture(url, seconds, burstMs = BURST_MS) {
  const stop = new AbortController();
  const chunks = [];
  const started = Date.now();
  const timer = setTimeout(() => stop.abort(), burstMs + seconds * 1000);
  try {
    const response = await fetch(url, { signal: stop.signal });
    if (!response.ok) throw new Error(`stream: HTTP ${response.status}`);
    for await (const chunk of response.body) if (Date.now() - started >= burstMs) chunks.push(Buffer.from(chunk));
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks);
}

/** Decodes MP3 in the browser, which needs no other tool in the container. */
export async function decode(page, bytes) {
  const { rate, pcm } = await page.evaluate(async (base64) => {
    const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const audio = await new OfflineAudioContext(1, 1, 44_100).decodeAudioData(data.buffer);
    const left = audio.getChannelData(0);
    const right = audio.numberOfChannels > 1 ? audio.getChannelData(1) : left;
    const out = new Int16Array(left.length);
    for (let i = 0; i < left.length; i += 1) out[i] = Math.max(-1, Math.min(1, (left[i] + right[i]) / 2)) * 32767;
    let text = "";
    const view = new Uint8Array(out.buffer);
    for (let i = 0; i < view.length; i += 32_768) text += String.fromCharCode(...view.subarray(i, i + 32_768));
    return { rate: audio.sampleRate, pcm: btoa(text) };
  }, bytes.toString("base64"));
  const raw = Buffer.from(pcm, "base64");
  const samples = new Float32Array(raw.length / 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = raw.readInt16LE(i * 2) / 32767;
  return { rate, samples };
}

/** The guest's camera and microphone: a moving picture and a steady tone, with no voice processing in the way. */
const toneMedia = ({ hz, gain }) => {
  const devices = window.MediaDevices && window.MediaDevices.prototype;
  if (!devices) return;
  devices.getUserMedia = async (constraints = {}) => {
    const tracks = [];
    if (constraints.video) {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 240;
      const drawing = canvas.getContext("2d");
      let frame = 0;
      setInterval(() => {
        drawing.fillStyle = `hsl(${(frame += 1) % 360},60%,40%)`;
        drawing.fillRect(0, 0, 320, 240);
      }, 100);
      tracks.push(...canvas.captureStream(10).getVideoTracks());
    }
    if (constraints.audio) {
      const context = new AudioContext();
      await context.resume();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = hz;
      const level = context.createGain();
      level.gain.value = gain;
      const out = context.createMediaStreamDestination();
      oscillator.connect(level).connect(out);
      oscillator.start();
      tracks.push(...out.stream.getAudioTracks());
    }
    return new MediaStream(tracks);
  };
  devices.enumerateDevices = async () => [
    { deviceId: "tone-camera", kind: "videoinput", label: "Test camera", groupId: "g" },
    { deviceId: "tone-mic", kind: "audioinput", label: "Test tone", groupId: "g" },
  ];
};

async function main() {
  if (!INVITATION) {
    console.error("Set ALCANTARA_INVITATION_PATH (an invitation made in /calls for the program).");
    process.exit(2);
  }
  const browser = await chromium.launch({
    args: ["--autoplay-policy=no-user-gesture-required", "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests"],
    ...(process.env.WEBRTC_EXECUTABLE ? { executablePath: process.env.WEBRTC_EXECUTABLE } : {}),
  });
  let before = null;
  let live = null;
  let after = null;
  let guest = null;
  const guestPage = { liveShown: null, offShown: null };
  try {
    const decoder = await browser.newPage();
    const listen = async (seconds) => {
      const { rate, samples } = await decode(decoder, await capture(STREAM, seconds));
      return toneReport(samples, rate, HZ);
    };
    // Listens in short pieces until the tone is in the wanted state, then measures it properly.
    const measureWhen = async (wanted, since) => {
      for (;;) {
        const piece = await listen(5);
        if (piece[wanted] || Date.now() - since > 150_000) {
          report("stream-changed", { wanted, reached: piece[wanted], secondsSinceCue: Math.round((Date.now() - since) / 1000), ...piece });
          return listen(LISTEN);
        }
      }
    };

    before = await listen(10);
    report("before", { hz: HZ, ...before });
    if (!before.absent) throw new Error(`the stream already carries ${HZ} Hz: choose another TONE_HZ`);

    const context = await browser.newContext({ permissions: ["camera", "microphone"] });
    await context.addInitScript(toneMedia, { hz: HZ, gain: GAIN });
    await context.route("**/__test/session**", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ accessToken: "", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), user: { sub: "", id: "", name: "", email: "" } }),
      }),
    );
    guest = await context.newPage();
    await guest.goto(`${APP}${INVITATION}`);
    await guest.getByRole("button", { name: /Speaker test/ }).click({ timeout: 60_000 });
    await guest.getByLabel(/I am wearing headphones/).check({ timeout: 60_000 });
    await guest.getByRole("button", { name: /Join studio/ }).click({ timeout: 60_000 });
    await guest.getByRole("button", { name: /Leave/ }).waitFor({ timeout: 60_000 });
    report("guest-joined");
    console.log("WAITING FOR ADMIT");
    await guest.getByText(/mix-minus/).waitFor({ timeout: 300_000 });
    report("guest-admitted");

    // The director's cue reaches the guest page as a notice carrying the cue's name.
    const cue = (name) => guest.locator("strong").filter({ hasText: new RegExp(`^${name}$`, "i") });
    console.log("WAITING FOR CUE LIVE");
    await cue("live").first().waitFor({ timeout: 600_000 });
    report("cued-live");
    // The guest's page must say so within 5 s of the cue. The banner follows the studio's cue on the heartbeat.
    guestPage.liveShown = await bannerShown(guest, "You're on air");
    report("guest-page", { step: "live", shows: "You're on air", shown: guestPage.liveShown, withinSeconds: 5 });
    live = await measureWhen("present", Date.now());
    report("live", live);
    console.log(live.present ? "TONE IS ON AIR" : "TONE NOT HEARD ON AIR");

    console.log("WAITING FOR WRAP");
    await cue("wrap").or(cue("standby")).first().waitFor({ timeout: 900_000 });
    report("wrapped");
    // The guest stays connected, so what goes is gone because of the wrap.
    guestPage.offShown = await bannerShown(guest, "Off air");
    report("guest-page", { step: "standby-or-wrap", shows: "Off air", shown: guestPage.offShown, withinSeconds: 5 });
    after = await measureWhen("absent", Date.now());
    report("after", after);
  } catch (error) {
    report("error", { error: String(error?.message ?? error).split("\n")[0] });
  } finally {
    await guest?.getByRole("button", { name: /Leave/ }).click({ timeout: 5_000 }).catch(() => undefined);
    await sleep(500);
    await browser.close();
  }
  const ok = proven(before, live, after, guestPage);
  const line = (name, r) => `${name}: ${r ? `tone in ${r.withTone}/${r.windows} half-second windows, ${r.toneDbfs} dBFS, ${r.aboveNeighboursDb} dB above neighbours` : "not measured"}`;
  console.log("--- summary");
  const guestLine = (label, value) => `guest page ${label}: ${value === null ? "not checked" : value ? "shown within 5 s" : "NOT shown"}`;
  console.log(
    [
      line("before", before),
      line("live", live),
      line("after wrap", after),
      guestLine('"You\'re on air" after the live cue', guestPage.liveShown),
      guestLine('"Off air" after standby or wrap', guestPage.offShown),
      ok ? "ON-AIR PROOF PASSED" : "ON-AIR PROOF FAILED",
    ].join("\n"),
  );
  process.exit(ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
