#!/usr/bin/env node
// Routing, levels and source loss, against a running local Alcántara (gaulatti/alcantara#51, the routing box), for
// what is built today:
//
//   scenes (program tv-demo):
//     1. Preview and Program are independent slots: staging a scene changes Preview and leaves Program on air;
//     2. the output page shows Program, and its confidence=preview view shows Preview;
//     3. TAKE moves the staged scene to Program, and the open output page follows over its stream, with no reload;
//   guests (program radio-demo.fm), two callers with a tone each (A 520 Hz, B 990 Hz), measured in A's return:
//     4. gain: B's gain at 0.25 puts B about 12 dB down in A's return; back at 1 it returns;
//     5. mute: B muted leaves A's return; unmuted it returns;
//     6. video drop: B turns its camera off, the room shows B's camera off and its microphone on, and A still hears B;
//     7. offline: B's page closes without leaving; the participants list flags B reconnecting, then offline once its
//        60-second session lease runs out, and B leaves A's return.
//
// Not built, so not checked (gaulatti/alcantara#51): Preview and Program audio buses (guests ride the program's stream
// master; the staged layer is always muted), a Preview/Program routing field for a guest or a source (a guest reaches
// Program only through a scene's webrtc-guest slot), per-guest solo, pan and audio-follow-video, a TAKE that refuses a
// source that is not ready, last-frame hold, and protection against reassigning a source routed to Program.
//
// It prints one JSON line per step and exits non-zero on the first failure. Nothing secret is printed. It restores the
// tv-demo scenes it changed and revokes the invitations it created.
//
// Configuration (environment): ALCANTARA_API_URL (default http://localhost:3000), ALCANTARA_APP_URL (default
// http://localhost:5173), ROUTING_SCENE_PROGRAM (default tv-demo), ROUTING_GUEST_PROGRAM (default radio-demo.fm),
// ALCANTARA_OPERATOR_TOKEN (else the local test-auth session), WEBRTC_TIMEOUT_MS (default 60000), WEBRTC_HEADED=1.

import { chromium } from "playwright";
import { SYNTHETIC_MEDIA } from "./synthetic-media.mjs";
import { gainVerdict, presentVerdict } from "./routing-levels.mjs";

const API = (process.env.ALCANTARA_API_URL || "http://localhost:3000").replace(
  /\/$/,
  "",
);
const APP = (process.env.ALCANTARA_APP_URL || "http://localhost:5173").replace(
  /\/$/,
  "",
);
const SCENE_PROGRAM = process.env.ROUTING_SCENE_PROGRAM || "tv-demo";
const GUEST_PROGRAM = process.env.ROUTING_GUEST_PROGRAM || "radio-demo.fm";
const TIMEOUT = Number(process.env.WEBRTC_TIMEOUT_MS || 60_000);
const GUESTS = [
  { name: "A", hz: 520 },
  { name: "B", hz: 990 },
];

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

const waitFor = async (check, timeoutMs = TIMEOUT, everyMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
};

/** The synthetic camera and microphone with this guest's own tone; the tracks it makes are kept, so a test can end one. */
const mediaWithTone = (hz) => {
  const script = SYNTHETIC_MEDIA.replace(
    "osc.frequency.value = 440;",
    `osc.frequency.value = ${hz};`,
  ).replace(
    "return new MediaStream(tracks);",
    "(window.__syntheticTracks = window.__syntheticTracks || []).push(...tracks); return new MediaStream(tracks);",
  );
  if (
    !script.includes(`osc.frequency.value = ${hz};`) ||
    !script.includes("__syntheticTracks")
  )
    throw new Error(
      "synthetic-media.mjs changed: the tone or the returned stream is no longer where this expects it",
    );
  return script;
};

/** Runs in a guest page: the level of each tone in the return it plays, averaged over `seconds`. */
async function returnLevels({ seconds, tones }) {
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

async function scenes(token, browser) {
  const state = () =>
    api(`/program/${encodeURIComponent(SCENE_PROGRAM)}/control/state`, {
      token,
    });
  const before = await state();
  const original = {
    active: before.activeSceneId,
    staged: before.stagedSceneId,
  };
  const assigned =
    (await api(`/program/${encodeURIComponent(SCENE_PROGRAM)}/scenes`, {
      token,
    }).catch(() => null)) ?? before.scenes;
  const sceneIds = (Array.isArray(assigned) ? assigned : [])
    .map((entry) => entry?.scene?.id ?? entry?.sceneId ?? entry?.id)
    .filter((id) => typeof id === "number");
  const onAir = original.active;
  const other = sceneIds.find((id) => id !== onAir);
  if (typeof onAir !== "number" || typeof other !== "number")
    fail("scenes-setup", {
      active: onAir,
      assigned: sceneIds.length,
      hint: "the program needs a scene on air and another assigned",
    });
  /** A scene's on-screen text, from the public state's projection of the Program or Preview slot. */
  const sceneText = (scene) => {
    try {
      const metadata =
        typeof scene?.metadata === "string"
          ? JSON.parse(scene.metadata)
          : scene?.metadata;
      return (
        Object.values(metadata ?? {})
          .map((value) => value?.text)
          .find((text) => typeof text === "string") ?? null
      );
    } catch {
      return null;
    }
  };
  try {
    await api(`/program/${encodeURIComponent(SCENE_PROGRAM)}/stage`, {
      method: "POST",
      token,
      body: { sceneId: other },
    });
    const staged = await state();
    if (staged.stagedSceneId !== other || staged.activeSceneId !== onAir)
      fail("preview-independent-of-program", {
        staged: staged.stagedSceneId,
        active: staged.activeSceneId,
        expected: { staged: other, active: onAir },
      });
    report("preview-independent-of-program", {
      ok: true,
      program: onAir,
      preview: other,
    });

    const slots = await api(
      `/program/${encodeURIComponent(SCENE_PROGRAM)}/state`,
    );
    const [onAirText, previewText] = [
      sceneText(slots.activeScene),
      sceneText(slots.stagedScene),
    ];
    const context = await browser.newContext();
    const output = await context.newPage();
    const confidence = await context.newPage();
    await output.goto(`${APP}/program/${encodeURIComponent(SCENE_PROGRAM)}`);
    await confidence.goto(
      `${APP}/program/${encodeURIComponent(SCENE_PROGRAM)}?confidence=preview`,
    );
    if (onAirText && previewText) {
      const shows = (page, text) =>
        page
          .getByText(text, { exact: false })
          .first()
          .waitFor({ timeout: TIMEOUT })
          .then(() => true)
          .catch(() => false);
      if (!(await shows(output, onAirText)))
        fail("output-shows-program", { expected: "the on-air scene's text" });
      if (!(await shows(confidence, previewText)))
        fail("preview-view-shows-preview", {
          expected: "the staged scene's text",
        });
      report("output-shows-program-and-preview", { ok: true });
    } else {
      report("output-shows-program-and-preview", {
        skipped: "the scenes carry no text to look for",
      });
    }

    await api(`/program/${encodeURIComponent(SCENE_PROGRAM)}/activate`, {
      method: "POST",
      token,
      body: { sceneId: other },
    });
    const taken = await waitFor(
      async () => {
        const now = await state();
        return now.activeSceneId === other ? now : null;
      },
      10_000,
      250,
    );
    if (!taken) fail("take-to-program", { expected: other });
    report("take-to-program", {
      ok: true,
      program: taken.activeSceneId,
      preview: taken.stagedSceneId,
    });
    if (previewText) {
      const followed = await output
        .getByText(previewText, { exact: false })
        .first()
        .waitFor({ timeout: TIMEOUT })
        .then(() => true)
        .catch(() => false);
      if (!followed)
        fail("output-follows-take", {
          expected: "the taken scene's text, without a reload",
        });
      report("output-follows-take", { ok: true });
    }
    await context.close();
  } finally {
    await api(`/program/${encodeURIComponent(SCENE_PROGRAM)}/activate`, {
      method: "POST",
      token,
      body: { sceneId: original.active },
    }).catch(() => undefined);
    await api(`/program/${encodeURIComponent(SCENE_PROGRAM)}/stage`, {
      method: "POST",
      token,
      body: { sceneId: original.staged ?? null },
    }).catch(() => undefined);
    const restored = await state().catch(() => null);
    report("scenes-restored", {
      ok:
        restored?.activeSceneId === original.active &&
        restored?.stagedSceneId === original.staged,
      active: restored?.activeSceneId,
      staged: restored?.stagedSceneId,
    });
  }
}

async function guests(token, browser) {
  const participants = async () =>
    (
      await api(
        `/webrtc/rooms/${encodeURIComponent(GUEST_PROGRAM)}/participants`,
        { token },
      )
    ).participants ?? [];
  const joined = [];
  try {
    for (const guest of GUESTS) {
      const invitation = await api("/webrtc/invitations", {
        method: "POST",
        token,
        body: {
          programId: GUEST_PROGRAM,
          displayName: `Routing check ${guest.name}`,
          expiresInHours: 1,
          returnVideo: "program",
          returnAudioBus: "master",
        },
      });
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
      await page.goto(`${APP}${invitation.invitationPath}`);
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
      await api(
        `/webrtc/invitations/${encodeURIComponent(invitation.id)}/admit`,
        { method: "POST", token },
      );
      await page.getByText(/mix-minus/).waitFor({ timeout: TIMEOUT });
      joined.push({
        ...guest,
        invitation,
        identity: `guest-${invitation.id}`,
        page,
        context,
      });
    }
    const [a, b] = joined;
    report("guests-ready", { ok: true, count: joined.length });

    const bInA = async () =>
      (await a.page.evaluate(returnLevels, { seconds: 8, tones: [b.hz] }))
        .levels[b.hz];
    const setReturn = (patch) =>
      api(`/webrtc/invitations/${encodeURIComponent(b.invitation.id)}/return`, {
        method: "PATCH",
        token,
        body: {
          returnVideo: b.invitation.returnVideo ?? "program",
          returnAudioBus: b.invitation.returnAudioBus ?? "master",
          sourceGain: 1,
          sourceMuted: false,
          sourceDelayMs: 0,
          ...patch,
        },
      });
    // The return router reads the routes on its poll; give it time before each measurement.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 6000));

    const unity = await bInA();
    const atQuarter = await (async () => {
      await setReturn({ sourceGain: 0.25 });
      await settle();
      return bInA();
    })();
    const gain = gainVerdict(unity, atQuarter, 0.25);
    report("guest-gain", gain);
    if (!gain.ok) fail("guest-gain-summary", {});

    await setReturn({ sourceMuted: true });
    await settle();
    const muted = presentVerdict(await bInA(), false);
    report("guest-mute", muted);
    if (!muted.ok) fail("guest-mute-summary", {});

    await setReturn({});
    await settle();
    const back = presentVerdict(await bInA(), true);
    report("guest-unmute", back);
    if (!back.ok) fail("guest-unmute-summary", {});

    // Video drop: B turns its camera off on its page; its microphone goes on. (A camera that goes away instead fires
    // `ended`, and LiveKit opens it again by itself, so the room never shows it missing: measured on this stack.)
    await b.page
      .getByRole("button", { name: /Camera on/ })
      .click({ timeout: TIMEOUT });
    await b.page
      .getByRole("button", { name: /Camera off/ })
      .waitFor({ timeout: TIMEOUT });
    const afterDrop = await waitFor(async () => {
      const entry = (await participants()).find(
        (participant) => participant.identity === b.identity,
      );
      const tracks = entry?.tracks ?? [];
      const mic = tracks.find(
        (track) => track.source === "microphone" && !track.muted,
      );
      const cameraLive = tracks.some(
        (track) => track.source === "camera" && !track.muted,
      );
      return mic && !cameraLive
        ? {
            tracks: tracks.map((track) => ({
              source: track.source,
              muted: track.muted,
            })),
          }
        : null;
    }, 30_000);
    const stillHeard = presentVerdict(await bInA(), true);
    report("video-drop-audio-continues", {
      ok: Boolean(afterDrop) && stillHeard.ok,
      roomTracks: afterDrop?.tracks ?? null,
      level: stillHeard.level,
    });
    if (!afterDrop || !stillHeard.ok) fail("video-drop-summary", {});

    // Offline: B's page closes without leaving, as a lost phone would.
    await b.context.close();
    const reconnecting = await waitFor(async () => {
      const entry = (await participants()).find(
        (participant) => participant.identity === b.identity,
      );
      return entry && entry.connectionState !== "connected"
        ? entry.connectionState
        : null;
    }, 30_000);
    report("guest-drop-flagged", {
      ok: Boolean(reconnecting),
      state: reconnecting,
    });
    if (!reconnecting) fail("guest-drop-summary", {});
    const offline = await waitFor(
      async () => {
        const entry = (await participants()).find(
          (participant) => participant.identity === b.identity,
        );
        return entry?.connectionState === "offline" ? entry : null;
      },
      120_000,
      5000,
    );
    report("guest-offline-flagged", {
      ok: Boolean(offline),
      state: offline?.connectionState ?? null,
    });
    if (!offline) fail("guest-offline-summary", {});
    const gone = presentVerdict(await bInA(), false);
    report("offline-guest-leaves-returns", gone);
    if (!gone.ok) fail("offline-guest-leaves-returns-summary", {});
  } finally {
    for (const guest of joined) {
      await guest.context.close().catch(() => undefined);
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
  }
}

async function main() {
  const config = await api("/webrtc/config");
  if (!config?.enabled) fail("config", { config });
  const token =
    process.env.ALCANTARA_OPERATOR_TOKEN ||
    (await api("/__test/session?identity=operator-a")).accessToken;
  report("config", { ok: true, scenes: SCENE_PROGRAM, guests: GUEST_PROGRAM });
  const browser = await chromium.launch({
    headless: process.env.WEBRTC_HEADED !== "1",
    args: [
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests",
    ],
  });
  try {
    await scenes(token, browser);
    await guests(token, browser);
  } finally {
    await browser.close();
  }
  report("not-built", {
    items: [
      "Preview and Program audio buses",
      "a Preview/Program routing field for a guest or a source",
      "per-guest solo",
      "pan",
      "audio-follow-video",
      "readiness-gated TAKE",
      "last-frame hold",
      "reassignment protection for a source routed to Program",
    ],
  });
  report("done", { ok: true });
}

main().catch((error) => {
  if (!(error instanceof CheckFailed))
    report("error", { ok: false, error: String(error?.message ?? error) });
  process.exitCode = 1;
});
