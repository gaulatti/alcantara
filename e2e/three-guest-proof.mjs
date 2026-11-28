#!/usr/bin/env node
// Three external callers in one program, against a running local Alcántara (gaulatti/alcantara#51, first box):
//
//   1. an operator creates three guest invitations through the API;
//   2. each guest opens the real guest page, signed out, with a generated camera and a microphone that plays a tone
//      of its own (guest A 520 Hz, B 990 Hz, C 1340 Hz), passes the preflight and joins;
//   3. green room: each guest is held waiting, off air, until the operator admits them;
//   4. the operator admits each, and each page reports its mix-minus return;
//   5. the operator receives every guest's audio and video, with bytes flowing;
//   6. mix-minus with no self-echo: each guest's return carries the other two guests' tones and never its own, first
//      off air, then with all three cued live (when the program bed, carrying live voices seconds late, must leave
//      every return, so no guest hears itself delayed).
//
// Chat and screen share are not built, so this does not check them.
//
// It prints one JSON line per step and exits non-zero on the first failure. Nothing secret is printed.
//
// Configuration (environment):
//   ALCANTARA_API_URL      backend origin                         (default http://localhost:3000)
//   ALCANTARA_APP_URL      frontend origin serving /guest/<token> (default http://localhost:5173)
//   ALCANTARA_PROGRAM_ID   program whose call room is used        (default radio-demo.fm)
//   ALCANTARA_OPERATOR_TOKEN  bearer with alcantara:webrtc:operate and :read; without it the local test-auth session
//                          (GET /__test/session) is used, which only a local stack serves
//   THREE_GUEST_RETURN_BUS the guests' return bus                 (default master)
//   WEBRTC_TIMEOUT_MS      per wait                               (default 60000)
//   WEBRTC_HEADED          set to 1 to watch the browsers

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { SYNTHETIC_MEDIA } from "./synthetic-media.mjs";
import { analyseTones, TONE_GUESTS } from "./three-guest-tones.mjs";

const require = createRequire(import.meta.url);
const LIVEKIT_UMD = join(
  dirname(require.resolve("livekit-client")),
  "livekit-client.umd.js",
);

const API = (process.env.ALCANTARA_API_URL || "http://localhost:3000").replace(
  /\/$/,
  "",
);
const APP = (process.env.ALCANTARA_APP_URL || "http://localhost:5173").replace(
  /\/$/,
  "",
);
const PROGRAM = process.env.ALCANTARA_PROGRAM_ID || "radio-demo.fm";
const BUS = process.env.THREE_GUEST_RETURN_BUS || "master";
const TIMEOUT = Number(process.env.WEBRTC_TIMEOUT_MS || 60_000);

const report = (step, details = {}) =>
  console.log(
    JSON.stringify({ step, at: new Date().toISOString(), ...details }),
  );
class CheckFailed extends Error {}
const fail = (step, details) => {
  report(step, { ok: false, ...details });
  throw new CheckFailed(step);
};

async function api(path, { method = "GET", body, token } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok)
    throw new Error(
      `${method} ${path}: ${response.status} ${json?.message ?? ""}`.trim(),
    );
  return json;
}

async function operatorToken() {
  if (process.env.ALCANTARA_OPERATOR_TOKEN)
    return process.env.ALCANTARA_OPERATOR_TOKEN;
  return (await api("/__test/session?identity=operator-a")).accessToken;
}

/** The synthetic camera and microphone, with this guest's own tone in place of the shared 440 Hz. */
const mediaWithTone = (hz) => {
  const script = SYNTHETIC_MEDIA.replace(
    "osc.frequency.value = 440;",
    `osc.frequency.value = ${hz};`,
  );
  if (script === SYNTHETIC_MEDIA)
    throw new Error(
      "synthetic-media.mjs no longer sets a 440 Hz tone to replace",
    );
  return script;
};

/** A blank page at the app's origin with the LiveKit client loaded, for the operator's receiving side. */
async function livekitPage(context) {
  const page = await context.newPage();
  const blank = `${APP}/__three-guest-check`;
  await page.route(blank, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Three guests</title>",
    }),
  );
  await page.goto(blank);
  await page.addScriptTag({ path: LIVEKIT_UMD });
  return page;
}

/** Joins as the operator and waits until every guest's audio and video arrive with bytes flowing. */
async function receiveGuests(page, credentials, identities) {
  return page.evaluate(
    async ({ serverUrl, token, identities, timeoutMs }) => {
      const { Room, RoomEvent } = window.LivekitClient;
      const room = new Room({ adaptiveStream: false, dynacast: false });
      const tracks = Object.fromEntries(
        identities.map((identity) => [identity, { audio: null, video: null }]),
      );
      room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        // A guest's microphone and camera; a return router's mix (also a microphone source) is not the guest's.
        if (
          tracks[participant.identity] &&
          !String(_publication.trackName).startsWith("mixminus:")
        )
          tracks[participant.identity][track.kind] = track;
      });
      await room.connect(serverUrl, token, { autoSubscribe: true });
      window.__room = room;
      const complete = () =>
        identities.every(
          (identity) => tracks[identity].audio && tracks[identity].video,
        );
      const deadline = Date.now() + timeoutMs;
      while (!complete() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 250));
      const bytes = async (track) => {
        let total = 0;
        if (!track) return 0;
        (await track.receiver.getStats()).forEach((stat) => {
          if (stat.type === "inbound-rtp") total += stat.bytesReceived || 0;
        });
        return total;
      };
      const before = {};
      for (const identity of identities)
        before[identity] = [
          await bytes(tracks[identity].audio),
          await bytes(tracks[identity].video),
        ];
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const result = {};
      for (const identity of identities) {
        const after = [
          await bytes(tracks[identity].audio),
          await bytes(tracks[identity].video),
        ];
        result[identity] = {
          audio: Boolean(tracks[identity].audio),
          video: Boolean(tracks[identity].video),
          audioBytes: after[0] - before[identity][0],
          videoBytes: after[1] - before[identity][1],
        };
      }
      return result;
    },
    { ...credentials, identities, timeoutMs: TIMEOUT },
  );
}

/**
 * Runs in a guest page: the spectrum of the return it plays, as level per tone frequency, averaged over `seconds`.
 * It reads whichever live audio element holds the return at each moment, since the router may replace its track.
 */
async function returnSpectrum({ seconds, tones }) {
  const element = () =>
    [...document.querySelectorAll("audio")].find((a) =>
      a.srcObject?.getAudioTracks().some((t) => t.readyState === "live"),
    );
  const context = new AudioContext();
  await Promise.race([
    context.resume(),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]).catch(() => undefined);
  const analyser = context.createAnalyser();
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0;
  let source = null;
  let current = null;
  const bins = new Float32Array(analyser.frequencyBinCount);
  const sums = Object.fromEntries(tones.map((hz) => [hz, 0]));
  let samples = 0;
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const playing = element();
    if (playing && playing.srcObject !== current) {
      source?.disconnect();
      current = playing.srcObject;
      source = context.createMediaStreamSource(current);
      source.connect(analyser);
    }
    if (source) {
      analyser.getFloatFrequencyData(bins);
      const width = context.sampleRate / analyser.fftSize;
      for (const hz of tones) {
        // The strongest bin within 10 Hz of the tone, in linear magnitude.
        let peak = 0;
        for (
          let bin = Math.floor((hz - 10) / width);
          bin <= Math.ceil((hz + 10) / width);
          bin += 1
        )
          peak = Math.max(peak, 10 ** (bins[bin] / 20));
        sums[hz] += peak;
      }
      samples += 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  source?.disconnect();
  await context.close();
  return {
    samples,
    levels: Object.fromEntries(
      tones.map((hz) => [hz, samples ? sums[hz] / samples : 0]),
    ),
  };
}

async function main() {
  const config = await api("/webrtc/config");
  if (!config?.enabled) fail("config", { config });
  if (Number(config.maxGuests) < TONE_GUESTS.length)
    fail("config", { maxGuests: config.maxGuests });
  report("config", {
    ok: true,
    maxGuests: config.maxGuests,
    program: PROGRAM,
    bus: BUS,
  });

  const token = await operatorToken();
  const browser = await chromium.launch({
    headless: process.env.WEBRTC_HEADED !== "1",
    args: [
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests",
    ],
  });
  const guests = [];
  const pages = [];
  try {
    for (const tone of TONE_GUESTS) {
      const invitation = await api("/webrtc/invitations", {
        method: "POST",
        token,
        body: {
          programId: PROGRAM,
          displayName: `Three-guest check ${tone.name}`,
          expiresInHours: 1,
          returnVideo: "program",
          returnAudioBus: BUS,
        },
      });
      guests.push({ ...tone, invitation, identity: `guest-${invitation.id}` });
    }
    report("invitations", {
      ok: true,
      guests: guests.map((guest) => ({
        name: guest.name,
        slot: guest.invitation.slotNumber,
      })),
    });

    // Each guest is its own signed-out phone, with its own tone.
    for (const guest of guests) {
      const context = await browser.newContext({
        permissions: ["camera", "microphone"],
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
      });
      await context.addInitScript(mediaWithTone(guest.hz));
      await context.route("**/__test/session**", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            accessToken: "",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            user: { sub: "", id: "", name: "", email: "" },
          }),
        }),
      );
      const page = await context.newPage();
      pages.push(page);
      guest.page = page;
      await page.goto(`${APP}${guest.invitation.invitationPath}`);
      await page
        .getByRole("button", { name: /Speaker test/ })
        .click({ timeout: TIMEOUT });
      await page
        .getByLabel(/I am wearing headphones/)
        .check({ timeout: TIMEOUT });
      await page
        .getByRole("button", { name: /Join studio/ })
        .click({ timeout: TIMEOUT });
      await page
        .getByRole("button", { name: /Leave/ })
        .waitFor({ timeout: TIMEOUT });
    }
    report("guests-joined", { ok: true, count: guests.length });

    // Green room: every guest waits, off air, until admitted.
    for (const guest of guests) {
      const waiting = await guest.page
        .getByText(/Waiting for the producer to let you in/)
        .waitFor({ timeout: TIMEOUT })
        .then(() => true)
        .catch(() => false);
      if (!waiting) fail("green-room-waiting", { guest: guest.name });
    }
    report("green-room-waiting", { ok: true, count: guests.length });

    for (const guest of guests) {
      await api(
        `/webrtc/invitations/${encodeURIComponent(guest.invitation.id)}/admit`,
        { method: "POST", token },
      );
      const admitted = await guest.page
        .getByText(/mix-minus/)
        .waitFor({ timeout: TIMEOUT })
        .then(() => true)
        .catch(() => false);
      if (!admitted) fail("guest-admitted", { guest: guest.name });
    }
    report("guests-admitted", { ok: true, count: guests.length });

    // With media permission Chromium offers the page's real local addresses, not mDNS names LiveKit cannot resolve.
    const operatorContext = await browser.newContext({
      permissions: ["camera", "microphone"],
    });
    const operatorPage = await livekitPage(operatorContext);
    pages.push(operatorPage);
    const atOperator = await receiveGuests(
      operatorPage,
      await api("/webrtc/operator-token", {
        method: "POST",
        token,
        body: { programId: PROGRAM },
      }),
      guests.map((guest) => guest.identity),
    );
    const missing = guests.filter((guest) => {
      const seen = atOperator[guest.identity];
      return (
        !seen.audio ||
        !seen.video ||
        seen.audioBytes <= 0 ||
        seen.videoBytes <= 0
      );
    });
    const receivedSummary = Object.fromEntries(
      guests.map((guest) => [guest.name, atOperator[guest.identity]]),
    );
    if (missing.length)
      fail("operator-receives-guests", { received: receivedSummary });
    report("operator-receives-guests", { ok: true, received: receivedSummary });

    // Mix-minus: each guest's return, measured on its own page at every guest's tone. Off air first; then with every
    // guest cued live, when the program bed (which carries the live voices seconds late) must leave every return, so
    // no guest hears itself delayed either.
    const tones = guests.map((guest) => guest.hz);
    const mixMinus = async (phase) => {
      const spectra = await Promise.all(
        guests.map((guest) =>
          guest.page.evaluate(returnSpectrum, { seconds: 12, tones }),
        ),
      );
      const verdicts = guests.map((guest, index) => ({
        phase,
        ...analyseTones(guest, guests, spectra[index]),
      }));
      for (const verdict of verdicts) report("mix-minus", verdict);
      if (verdicts.some((verdict) => !verdict.ok))
        fail("mix-minus-summary", {
          phase,
          failed: verdicts.filter((v) => !v.ok).map((v) => v.guest),
        });
      report("mix-minus-summary", { ok: true, phase, guests: verdicts.length });
    };
    await mixMinus("off-air");

    for (const guest of guests) {
      await api(
        `/webrtc/rooms/${encodeURIComponent(PROGRAM)}/participants/${encodeURIComponent(guest.identity)}/control`,
        {
          method: "POST",
          token,
          body: { type: "cue", cue: "live" },
        },
      );
      const live = await guest.page
        .getByText(/You're on air/)
        .first()
        .waitFor({ timeout: TIMEOUT })
        .then(() => true)
        .catch(() => false);
      if (!live) fail("guests-cued-live", { guest: guest.name });
    }
    report("guests-cued-live", { ok: true, count: guests.length });
    await mixMinus("on-air");
  } finally {
    for (const page of pages)
      await page
        .evaluate(async () => {
          if (window.__room) await window.__room.disconnect();
        })
        .catch(() => undefined);
    await browser.close();
    for (const guest of guests)
      await api(
        `/webrtc/invitations/${encodeURIComponent(guest.invitation.id)}`,
        { method: "DELETE", token },
      ).catch((error) =>
        report("cleanup", {
          ok: false,
          guest: guest.name,
          error: String(error.message),
        }),
      );
  }
  report("done", { ok: true });
}

main().catch((error) => {
  if (!(error instanceof CheckFailed))
    report("error", { ok: false, error: String(error?.message ?? error) });
  process.exitCode = 1;
});
