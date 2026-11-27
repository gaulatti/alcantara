#!/usr/bin/env node
// An end-to-end guest call against a running Alcántara (gaulatti/alcantara#354), as a repeatable check:
//
//   1. an operator creates a guest invitation through the API;
//   2. a synthetic desktop program feed joins and publishes a moving test picture, as the pilot's Feed does;
//   3. a guest opens the real guest page in Chromium with a fake camera and microphone, passes the preflight and joins;
//   4. the operator side receives the guest's audio and video (bytes flowing), and so does the program feed when a
//      renderer key is given;
//   5. the guest receives the program return picture;
//   6. the invitation is revoked and every participant leaves.
//
// It prints one JSON line per step and exits non-zero on the first failure. Nothing secret is printed.
//
// Configuration (environment):
//   ALCANTARA_API_URL      backend origin                         (default http://localhost:3000)
//   ALCANTARA_APP_URL      frontend origin serving /guest/<token> (default http://localhost:5173)
//   ALCANTARA_PROGRAM_ID   program whose call room is used        (default main)
//   ALCANTARA_OPERATOR_TOKEN  bearer of a principal with alcantara:webrtc:operate and :read. Without it, the
//                          local test-auth session (GET /__test/session) is used, which only a local stack serves.
//   ALCANTARA_RENDERER_KEY optional: also check the program feed receives the guest (renderer-source token)
//   WEBRTC_EXPECT_ICE_URL  optional: an ICE server URL LiveKit must hand out (for example the TURN-over-TLS
//                          turns:…:443?transport=tcp), checked on the operator's connection
//   WEBRTC_SYNTHETIC_FEED  set to 0 to skip the synthetic desktop program feed. It joins as the pilot's fixed
//                          identity desktop-program-feed-<program>, so it would push a real desktop Feed out of the
//                          room: never leave it on against a program whose pilot is connected.
//   WEBRTC_EXPECT_RETURN   set to 0 to skip the guest's return check (no program feed in the room)
//   ALCANTARA_INVITATION_PATH  guest only: join this /guest/<token> path (an invitation an operator created in the
//                          console) without any operator token. Only the guest side is checked, and the invitation is
//                          left for the operator to revoke.
//   WEBRTC_HOLD_SECONDS    keep the joined guest in the room this long, reporting what it sends every 15 s
//                          (default 0)
//   WEBRTC_TIMEOUT_MS      per wait                               (default 45000)
//   WEBRTC_HEADED          set to 1 to watch the browser

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
// The package's exports hide its UMD build, which sits beside the entry it does export.
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
const PROGRAM = process.env.ALCANTARA_PROGRAM_ID || "main";
const RENDERER_KEY = process.env.ALCANTARA_RENDERER_KEY || "";
const TIMEOUT = Number(process.env.WEBRTC_TIMEOUT_MS || 45_000);
const EXPECT_ICE_URL = process.env.WEBRTC_EXPECT_ICE_URL || "";
const GUEST_ONLY_PATH = process.env.ALCANTARA_INVITATION_PATH || "";
const SYNTHETIC_FEED =
  !GUEST_ONLY_PATH && process.env.WEBRTC_SYNTHETIC_FEED !== "0";
const EXPECT_RETURN = process.env.WEBRTC_EXPECT_RETURN !== "0";
const HOLD_SECONDS = Number(process.env.WEBRTC_HOLD_SECONDS || 0);

/** What the guest page's own connections send, and the ICE pair they use: no address, only the candidate types. */
const guestSends = (page) =>
  page.evaluate(async () => {
    const out = { audioBytes: 0, videoBytes: 0, pairs: [] };
    for (const pc of window.__guestPcs ?? []) {
      if (pc.connectionState === "closed") continue;
      const report = await pc.getStats();
      const byId = new Map();
      report.forEach((stat) => byId.set(stat.id, stat));
      report.forEach((stat) => {
        if (stat.type === "outbound-rtp") out[`${stat.kind}Bytes`] += stat.bytesSent || 0;
        if (stat.type === "candidate-pair" && stat.nominated && stat.state === "succeeded") {
          const local = byId.get(stat.localCandidateId);
          const remote = byId.get(stat.remoteCandidateId);
          out.pairs.push(
            `${local?.candidateType}/${local?.protocol} -> ${remote?.candidateType}/${remote?.protocol}:${remote?.port}` +
              (stat.currentRoundTripTime ? ` rtt ${Math.round(stat.currentRoundTripTime * 1000)} ms` : ""),
          );
        }
      });
    }
    return out;
  });

const report = (step, details = {}) =>
  console.log(
    JSON.stringify({ step, at: new Date().toISOString(), ...details }),
  );

class CheckFailed extends Error {}
const fail = (step, details) => {
  report(step, { ok: false, ...details });
  throw new CheckFailed(step);
};

async function api(path, { method = "GET", body, token, headers = {} } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
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
  if (!response.ok) {
    const message =
      json && typeof json.message === "string"
        ? json.message
        : `HTTP ${response.status}`;
    throw new Error(`${method} ${path}: ${response.status} ${message}`);
  }
  return json;
}

async function operatorToken() {
  if (process.env.ALCANTARA_OPERATOR_TOKEN)
    return process.env.ALCANTARA_OPERATOR_TOKEN;
  const session = await api("/__test/session?identity=operator-a");
  return session.accessToken;
}

/**
 * A blank page with the LiveKit client loaded, for the synthetic participants. It is served at the app's own origin
 * (never fetched from it): about:blank has an opaque origin, which Chromium does not let reach LiveKit on localhost.
 */
async function livekitPage(context) {
  const page = await context.newPage();
  const blank = `${APP}/__webrtc-call-check`;
  await page.route(blank, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>WebRTC call check</title>",
    }),
  );
  // Records the ICE servers each peer connection is given: LiveKit sends them in its join response.
  await page.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    window.__iceServers = [];
    window.RTCPeerConnection = function (config, ...rest) {
      for (const server of config?.iceServers ?? [])
        for (const url of [].concat(server.urls ?? []))
          window.__iceServers.push(url);
      return new Native(config, ...rest);
    };
    window.RTCPeerConnection.prototype = Native.prototype;
  });
  await page.goto(blank);
  await page.addScriptTag({ path: LIVEKIT_UMD });
  return page;
}

/** Joins as the desktop program feed and publishes a moving test picture as a screen share. */
async function publishProgramFeed(page, credentials) {
  return page.evaluate(async ({ serverUrl, token }) => {
    const { Room, Track } = window.LivekitClient;
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext("2d");
    let frame = 0;
    setInterval(() => {
      frame += 1;
      ctx.fillStyle = `hsl(${(frame * 7) % 360} 55% 45%)`;
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = "#fff";
      ctx.font = "36px sans-serif";
      ctx.fillText(`SYNTHETIC PROGRAM ${frame}`, 24, 190);
    }, 100);
    const room = new Room();
    await room.connect(serverUrl, token);
    await room.localParticipant.publishTrack(
      canvas.captureStream(10).getVideoTracks()[0],
      {
        source: Track.Source.ScreenShare,
        name: "synthetic-program",
      },
    );
    window.__room = room;
    return room.localParticipant.identity;
  }, credentials);
}

/** Joins as a subscriber and waits until the guest's audio and video both arrive, with bytes flowing. */
async function receiveGuest(page, credentials, guestIdentity) {
  return page.evaluate(
    async ({ serverUrl, token, guestIdentity, timeoutMs }) => {
      const { Room, RoomEvent } = window.LivekitClient;
      const room = new Room({ adaptiveStream: false, dynacast: false });
      const tracks = { audio: null, video: null };
      room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        if (participant.identity === guestIdentity) tracks[track.kind] = track;
      });
      await room.connect(serverUrl, token, { autoSubscribe: true });
      window.__room = room;
      const deadline = Date.now() + timeoutMs;
      while ((!tracks.audio || !tracks.video) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 250));
      if (!tracks.audio || !tracks.video)
        return {
          ok: false,
          audio: Boolean(tracks.audio),
          video: Boolean(tracks.video),
          participants: [...room.remoteParticipants.keys()],
        };
      const received = async (track) => {
        let bytes = 0;
        (await track.receiver.getStats()).forEach((stat) => {
          if (stat.type === "inbound-rtp") bytes += stat.bytesReceived || 0;
        });
        return bytes;
      };
      const before = [
        await received(tracks.audio),
        await received(tracks.video),
      ];
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const after = [
        await received(tracks.audio),
        await received(tracks.video),
      ];
      return {
        ok: after[0] > before[0] && after[1] > before[1],
        audioBytes: after[0] - before[0],
        videoBytes: after[1] - before[1],
      };
    },
    { ...credentials, guestIdentity, timeoutMs: TIMEOUT },
  );
}

async function leave(page) {
  await page
    .evaluate(async () => {
      if (window.__room) await window.__room.disconnect();
    })
    .catch(() => undefined);
}

async function main() {
  const config = await api("/webrtc/config");
  if (!config?.enabled) fail("config", { config });
  report("config", { ok: true, maxGuests: config.maxGuests });

  const token = GUEST_ONLY_PATH ? null : await operatorToken();
  const invitation = GUEST_ONLY_PATH
    ? { id: null, invitationPath: GUEST_ONLY_PATH }
    : await api("/webrtc/invitations", {
        method: "POST",
        token,
        body: {
          programId: PROGRAM,
          displayName: "Synthetic call check",
          expiresInHours: 1,
          returnVideo: "program",
          returnAudioBus: "master",
        },
      });
  const guestIdentity = `guest-${invitation.id}`;
  report(
    "invitation",
    GUEST_ONLY_PATH
      ? { given: true }
      : { ok: true, id: invitation.id, slot: invitation.slotNumber },
  );

  const browser = await chromium.launch({
    headless: process.env.WEBRTC_HEADED !== "1",
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      // A local stack serves LiveKit on loopback, which Chromium's Local Network Access check would hold behind a
      // permission prompt nobody answers. Production's LiveKit is public, so this changes nothing there.
      "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests",
    ],
  });
  const context = await browser.newContext({
    permissions: ["camera", "microphone"],
  });
  const pages = [];
  try {
    if (SYNTHETIC_FEED) {
      const feedPage = await livekitPage(context);
      pages.push(feedPage);
      const feedIdentity = await publishProgramFeed(
        feedPage,
        await api("/webrtc/desktop-program-feed-token", {
          method: "POST",
          token,
          body: { programId: PROGRAM },
        }),
      );
      report("program-feed", { ok: true, identity: feedIdentity });
    } else {
      report("program-feed", {
        skipped: GUEST_ONLY_PATH ? "guest only" : "WEBRTC_SYNTHETIC_FEED=0",
      });
    }

    // The guest is signed out, as in production, where the sign-in library answers a session with no ID token. In its
    // own context the local test-auth session is answered the same way (gaulatti/alcantara#354: a fetch wrapper that
    // needed a token stopped every production guest's join before it left the browser).
    const guestContext = await browser.newContext({ permissions: ["camera", "microphone"] });
    await guestContext.route("**/__test/session**", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          accessToken: "",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          user: { sub: "", id: "", name: "", email: "" },
        }),
      }),
    );
    const guest = await guestContext.newPage();
    // Keeps the guest page's peer connections, to report what it sends.
    await guest.addInitScript(() => {
      const Native = window.RTCPeerConnection;
      window.__guestPcs = [];
      window.RTCPeerConnection = function (config, ...rest) {
        const pc = new Native(config, ...rest);
        window.__guestPcs.push(pc);
        return pc;
      };
      window.RTCPeerConnection.prototype = Native.prototype;
    });
    pages.push(guest);
    await guest.goto(`${APP}${invitation.invitationPath}`);
    await guest
      .getByRole("button", { name: /Speaker test/ })
      .click({ timeout: TIMEOUT });
    await guest
      .getByLabel(/I am wearing headphones/)
      .check({ timeout: TIMEOUT });
    await guest
      .getByRole("button", { name: /Join studio/ })
      .click({ timeout: TIMEOUT });
    // Live: the page offers Leave only once it is in the room.
    await guest
      .getByRole("button", { name: /Leave/ })
      .waitFor({ timeout: TIMEOUT });
    report("guest-joined", { ok: true });
    if (HOLD_SECONDS > 0) {
      let last = await guestSends(guest);
      for (let held = 15; held <= HOLD_SECONDS; held += 15) {
        await guest.waitForTimeout(15_000);
        const now = await guestSends(guest);
        // Audio always flows from a joined guest; video can pause while nobody subscribes to it.
        if (now.audioBytes <= last.audioBytes) fail("guest-sends", { seconds: held, ...now });
        report("guest-sends", { ok: true, seconds: held, ...now });
        last = now;
      }
    }

    if (!GUEST_ONLY_PATH) {
      const operatorPage = await livekitPage(context);
      pages.push(operatorPage);
      const atOperator = await receiveGuest(
        operatorPage,
        await api("/webrtc/operator-token", {
          method: "POST",
          token,
          body: { programId: PROGRAM },
        }),
        guestIdentity,
      );
      if (!atOperator.ok) fail("operator-receives-guest", atOperator);
      report("operator-receives-guest", atOperator);

      // The ICE servers LiveKit handed out: only their scheme and port are reported, never a credential.
      const iceUrls = [
        ...new Set(await operatorPage.evaluate(() => window.__iceServers)),
      ];
      const iceSummary = iceUrls.map((url) =>
        url.replace(/^(\w+):([^:?]+)/, "$1:<host>"),
      );
      if (EXPECT_ICE_URL && !iceUrls.includes(EXPECT_ICE_URL))
        fail("ice-servers", { expected: EXPECT_ICE_URL, offered: iceSummary });
      report("ice-servers", {
        ok: true,
        offered: iceSummary,
        ...(EXPECT_ICE_URL ? { expected: "present" } : {}),
      });

      if (RENDERER_KEY) {
        const programPage = await livekitPage(context);
        pages.push(programPage);
        const atProgram = await receiveGuest(
          programPage,
          await api("/webrtc/renderer-source-token", {
            method: "POST",
            headers: { "x-renderer-key": RENDERER_KEY },
            body: { programId: PROGRAM },
          }),
          guestIdentity,
        );
        if (!atProgram.ok) fail("program-receives-guest", atProgram);
        report("program-receives-guest", atProgram);
      } else {
        report("program-receives-guest", {
          skipped: "no ALCANTARA_RENDERER_KEY",
        });
      }
    } else {
      report("operator-receives-guest", {
        skipped: "guest only: the operator checks the console",
      });
    }

    // The guest's return: the waiting notice goes, and the return picture plays.
    const returned = await guest
      .waitForFunction(
        () => {
          if (
            document.body.innerText.includes("Waiting for selected return feed")
          )
            return false;
          const video = [...document.querySelectorAll("video")].find(
            (element) => !element.muted,
          );
          return Boolean(
            video && video.videoWidth > 0 && video.currentTime > 1,
          );
        },
        undefined,
        { timeout: TIMEOUT },
      )
      .then(() => true)
      .catch(() => false);
    if (EXPECT_RETURN) {
      if (!returned) fail("guest-receives-return", {});
      report("guest-receives-return", { ok: true });
    } else {
      report("guest-receives-return", {
        skipped: "WEBRTC_EXPECT_RETURN=0",
        seen: returned,
      });
    }
  } finally {
    for (const page of pages) await leave(page);
    await browser.close();
    if (invitation.id)
      await api(`/webrtc/invitations/${encodeURIComponent(invitation.id)}`, {
        method: "DELETE",
        token,
      }).catch((error) =>
        report("cleanup", { ok: false, error: String(error.message) }),
      );
  }
  report("done", { ok: true });
}

main().catch((error) => {
  if (!(error instanceof CheckFailed))
    report("error", { ok: false, error: String(error?.message ?? error) });
  process.exitCode = 1;
});
