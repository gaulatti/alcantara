# End-to-end browser checks

Checks that drive a real browser against a running Alcántara.

## WebRTC guest call (`webrtc-call.mjs`, alcantara#354)

One run proves the whole call path:

1. An operator creates a guest invitation through the API.
2. A synthetic **desktop program feed** joins as `desktop-program-feed-<program>` and publishes a moving test picture as a screen share, as the pilot's Feed does.
3. A guest opens the real **guest page** (`/guest/<token>`) in Chromium with a fake camera and microphone (`--use-fake-device-for-media-stream`). It plays the speaker test, ticks "I am wearing headphones" and presses "Join studio". The guest runs **signed out**, as in production, where the sign-in library answers a session with no ID token; in its own browser context the local test-auth session is answered the same way. A fetch wrapper that needed a token once stopped every production guest's join (#847).
   While the guest waits, the producer talks to it privately with a screening token, and the guest page must be playing that audio (full runs only).
   The guest then waits to be let in; the script admits it through the API (in a guest-only run, the operator presses **Admit** within `WEBRTC_TIMEOUT_MS`).
4. The **operator side** (an operator token) receives the guest's audio and video, with bytes flowing. With a renderer key, so does the **program feed** (a renderer-source token).
5. The guest **receives the program return**: the waiting notice goes and the return picture plays.
6. The invitation is revoked and every participant leaves.

It prints one JSON line per step and exits non-zero on the first failure. It never prints a token or a credential.

### Run it against the local stack

```bash
docker compose up --build
pnpm install
pnpm --filter @gaulatti/alcantara-e2e browsers
ALCANTARA_RENDERER_KEY=alcantara-local-renderer-secret-change-me-now pnpm --filter @gaulatti/alcantara-e2e webrtc
```

The defaults point at Compose: the API on `http://localhost:3000`, the app on `http://localhost:5173`, program `main`, and the local test-auth operator session.

Chromium's Local Network Access check would hold a page's connection to LiveKit on loopback behind a permission prompt. The script turns that check off, because a local stack's LiveKit is on localhost. A person using a local stack in a real Chrome sees that prompt and must allow it. Production's public LiveKit isn't affected.

### Settings

| Variable | Meaning |
| --- | --- |
| `ALCANTARA_API_URL`, `ALCANTARA_APP_URL` | The backend and frontend origins. |
| `ALCANTARA_PROGRAM_ID` | The program whose call room is used (default `main`). Run it once with a program id that has a dot too, such as `modoitaliano.fm` (create the program first): production's dotted programs once had every guest call refused. |
| `ALCANTARA_OPERATOR_TOKEN` | Bearer of a principal with `alcantara:webrtc:operate` and `alcantara:webrtc:read`. Without it, the local test-auth session is used. |
| `ALCANTARA_RENDERER_KEY` | Also check the program feed receives the guest. |
| `WEBRTC_SYNTHETIC_FEED=0` | Skip the synthetic desktop feed. It uses the pilot's fixed identity, so it would push a real desktop Feed out of the room. |
| `WEBRTC_EXPECT_RETURN=0` | Skip the guest's return check when no program feed is in the room. |
| `ALCANTARA_INVITATION_PATH` | **Guest only:** join an invitation an operator made in the console. No operator token is needed; only the guest side is checked, and the invitation is left for the operator to revoke. |
| `WEBRTC_EXPECT_ICE_URL` | An ICE server URL LiveKit must hand out, for example the TURN-over-TLS `turns:…:443?transport=tcp`. Only scheme and port are printed. |
| `WEBRTC_HOLD_SECONDS` | Keep the joined guest in the room this long, reporting every 15 s what it sends (`guest-sends`: audio and video bytes, and the selected ICE pair by candidate type and port). It fails if the guest's audio stops. Video can pause while nobody subscribes to it. |
| `WEBRTC_TIMEOUT_MS`, `WEBRTC_HEADED=1` | The per-wait timeout, and watching the browser. |

### Against production

Production needs no new principal for a **guest-only** run. An operator creates an invitation in `/calls` for a program that is **not on air**, so the synthetic guest never reaches a live picture. Then:

```bash
ALCANTARA_API_URL=<production API origin> ALCANTARA_APP_URL=<production app origin> \
ALCANTARA_INVITATION_PATH=/guest/<token> WEBRTC_EXPECT_RETURN=0 \
pnpm --filter @gaulatti/alcantara-e2e webrtc
```

The operator presses **Admit** on the waiting guest in `/calls`, watches them appear with picture and sound, then revokes the invitation. A full run (`ALCANTARA_OPERATOR_TOKEN`) would also check the operator side automatically. Never run it with the synthetic feed against a program whose pilot Feed is connected.

### From outside the studio's network, with Docker only

A host with Docker can run the guest-only check from the official Playwright image (the same Playwright version as
`package.json`). Nothing else is installed on the host. Set `ALCANTARA_INVITATION_PATH` in the shell first; it is
passed by name and never printed:

```bash
docker run --rm --init --ipc=host -e ALCANTARA_INVITATION_PATH -e ALCANTARA_API_URL=https://api.alcantara.gaulatti.com -e ALCANTARA_APP_URL=https://alcantara.gaulatti.com -e WEBRTC_EXPECT_RETURN=0 -e WEBRTC_HOLD_SECONDS=60 mcr.microsoft.com/playwright:v1.65.0-noble bash -c 'set -e; mkdir /w && cd /w && curl -fsSL https://codeload.github.com/gaulatti/alcantara/tar.gz/main | tar xz --strip-components=1 && npx -y pnpm@9 install --frozen-lockfile --filter @gaulatti/alcantara-e2e >/dev/null && npx -y pnpm@9 --filter @gaulatti/alcantara-e2e webrtc'
```

## Engine and program matrix (`webrtc-matrix.mjs`)

The guest call runs in three engines, one after another, at 375 × 812 with touch: Chromium, WebKit (closest to iPhone Safari) and Firefox. Each engine runs `webrtc-call.mjs` with `WEBRTC_BROWSER` set. The program defaults to the dotted ID `radio-demo.fm`, not `main`, so a dotted program ID is exercised by default. The run prints one JSON line per engine and a summary line, and exits non-zero if any engine fails.

```bash
ALCANTARA_APP_URL=http://localhost:5391 pnpm --filter @gaulatti/alcantara-e2e webrtc:matrix
```

Set `ALCANTARA_PROGRAM_ID` to run the matrix against another program. Set `WEBRTC_BROWSER=chromium|webkit|firefox` to run one engine through `webrtc-call.mjs` directly. The other settings are the same as the WebRTC guest call above.

Engines use generated media, because a headless engine has no camera or microphone. Chromium and Firefox use their fake-device switches. WebKit has none, so `webrtc-call.mjs` installs an init script that replaces `getUserMedia` with a moving canvas and a steady oscillator tone. The bytes-flowing checks then measure the same path as the other engines.

Install the three engines once with `pnpm --filter @gaulatti/alcantara-e2e browsers:all`. The plain `browsers` script installs Chromium only.

## Three callers in one program (`three-guest-proof.mjs`, alcantara#51)

Three external callers join one program and the full call path is checked against a running local stack: guest pages, green room, LiveKit, the operator side and the return runner's mix-minus.

1. Three invitations are created through the API.
2. Each guest opens the real guest page as a signed-out phone (375 × 812, touch). It has a generated camera and a microphone that plays a tone of its own: guest A 520 Hz, B 990 Hz, C 1340 Hz. The tones avoid 440 Hz, the shared synthetic tone, and its harmonics. Each guest passes the preflight and joins.
3. Green room: every guest is held on **Waiting for the producer to let you in**, off air.
4. The operator admits each one, and each page reports its mix-minus return.
5. The operator receives every guest's audio and video, with bytes flowing.
6. Mix-minus: each guest's page measures the spectrum of the return it plays, at all three tones.
   - Each return must carry both other guests' tones and leave its own at least 20 dB below the quieter of them. That is no self-echo.
   - It is measured once off air, then again with all three cued live. While anyone is live the program bed carries their voices a few seconds late and must leave every return, so no guest hears itself delayed either.
   - The verdict is in `three-guest-tones.mjs` and tested by `three-guest-tones.test.mjs`.

```sh
docker compose up --build          # from the repository root: LiveKit, the return runner and the rest
cd e2e && pnpm install && pnpm browsers
pnpm three-guests                  # against http://localhost:3000 and :5173, program radio-demo.fm
```

Settings: `ALCANTARA_API_URL`, `ALCANTARA_APP_URL`, `ALCANTARA_PROGRAM_ID`, `ALCANTARA_OPERATOR_TOKEN` (without it the local test-auth session is used), `THREE_GUEST_RETURN_BUS` (default `master`), `WEBRTC_TIMEOUT_MS`, and `WEBRTC_HEADED=1` to watch.

Measured on a fresh clone's Compose stack (2026-11-28): every return carried the other two tones at about 0.13 to 0.14 and its own at 0.0004 to 0.0009, about 44 to 50 dB below, both off air and on air. As a negative control, a return router changed to include each guest's own voice made all three guests fail, with their own tone at about 0.11.

Not checked, because they are not built: chat (general and producer 1:1) and guest screen share.

On macOS with Colima, clone under your home directory. Colima shares only that with its VM, so a checkout elsewhere (for example under `/tmp`) leaves LiveKit with an empty directory where `infra/livekit.dev.yaml` should be, and it exits with `read /etc/livekit.yaml: is a directory`.

## Routing, levels and source loss (`routing-proof.mjs`, alcantara#51)

This proof checks what is built against a running local stack, the same way as the three-caller proof.

Scenes, on program `tv-demo`:
1. **Preview is independent of Program.** Staging a scene (`POST /program/:id/stage`) changes Preview and leaves Program on air.
2. **The output page shows Program, and its `?confidence=preview` view shows Preview.**
3. **TAKE** (`POST /program/:id/activate`) moves the staged scene to Program, and the open output page follows over its stream, with no reload. The scenes are put back afterwards.

Guests, on program `radio-demo.fm`: two callers, each with a tone of its own (A 520 Hz, B 990 Hz). B is measured in A's return.

4. **Gain.** B's `sourceGain` at 0.25 (`PATCH /webrtc/invitations/:id/return`) puts B 12 dB down. At 1 it returns.
5. **Mute.** B's `sourceMuted` takes B out of A's return. Unmuted, B returns.
6. **Video drop.** B turns its camera off on its page. The room shows B's camera muted and its microphone live, and A still hears B.
7. **Offline.** B's page closes without leaving. The participants list flags B `reconnecting`, then `offline` once its 60-second session lease runs out, and B leaves A's return.

```sh
cd e2e && pnpm routing-proof       # against a docker compose up --build stack
```

Settings: `ALCANTARA_API_URL`, `ALCANTARA_APP_URL`, `ROUTING_SCENE_PROGRAM` (default `tv-demo`), `ROUTING_GUEST_PROGRAM` (default `radio-demo.fm`), `ALCANTARA_OPERATOR_TOKEN`, `WEBRTC_TIMEOUT_MS`, `WEBRTC_HEADED=1`. The level verdicts are in `routing-levels.mjs`, tested by `routing-levels.test.mjs`.

Measured on a fresh clone's Compose stack (2026-11-28):
- **Gain:** 0.25 set, ratio 0.251 to 0.254 measured (−12.0 dB).
- **Mute:** B's tone at 0 in A's return.
- **Video drop:** B's camera muted, its microphone at 0.200 in A's return.
- **Drop:** `reconnecting` 20 s after the page closed, then `offline` 25 s later.

Two negative controls both failed the proof, as they should:
- A return router that ignored gain measured a ratio of 1.03.
- A return router that ignored mute left B at 0.20.

A camera that goes away fires `ended`, and LiveKit opens it again by itself. So a lost camera that the system can reopen never shows as missing; the proof drops video with the page's camera button instead.

Not built, so not checked:
- Preview and Program audio buses. Guests ride the program's stream master, and the staged layer is always muted.
- A Preview/Program routing field for a guest or a source. A guest reaches Program only through a scene's guest slot.
- Per-guest solo, pan and audio-follow-video.
- A TAKE that refuses a source that is not ready.
- Last-frame hold.
- Protection against reassigning a source that is routed to Program.

## Source types (`sources-proof.mjs`, alcantara#51)

What each source type can do on the local stack: whether it warms up and becomes a usable logical input.

```bash
docker compose up --build
pnpm install
pnpm --filter @gaulatti/alcantara-e2e browsers
pnpm --filter @gaulatti/alcantara-e2e sources-proof
```

One JSON line per type: `pass`, `fail` or `not-built`. A caller and Alana's program feed identity are checked in a real
call (Alana itself is not run). HLS, RTMP, WHIP and SRT are created in the registry and watched for
`PROOF_WAIT_SECONDS` (20): nothing ingests them today, so they report `not-built`, as does MP4, which has no transport.
The Sources page must say SRT is not available. It runs against a local stack only and removes what it creates.

## Program return proof (`return-proof-all.mjs`)

A guest joins the real guest page in Chromium, WebKit and Firefox, then as a phone twice (`iphone`: WebKit with Playwright's iPhone 15 viewport, user agent and touch; `android`: Chromium with Pixel 7), one after another, and the level of the return that page plays is measured. `RETURN_RUNS=iphone,android` runs only those. `chromium-tcp` is Chromium with plain UDP forbidden to WebRTC, as behind an office or hotel Wi-Fi: it passes the same bar and also fails if the pair used was UDP. `chromium-relay` also allows only relayed paths (set on the page's connections by the harness, not by a product switch), as on a network that leaves only TCP 443: it must connect through a relay over TLS. It is not part of the default set. Until TURN over TLS is set up (`infra/README.md`) it fails with `no relay candidates offered`. Every run prints an `ice-path` line (candidate types, protocols and the server port, no addresses), and a run that cannot connect lists what the server offered. Nothing else is opened, so sound means the server's return router delivered it. It defaults to production and `modoitaliano.fm`.

```bash
ALCANTARA_INVITATION_PATH=/guest/<token> pnpm --filter @gaulatti/alcantara-e2e return-proof
```

Make the invitation in `/calls`. Each time `WAITING FOR ADMIT <browser>` is printed, press **Admit** within 180 seconds. Between browsers it waits 70 seconds for the previous guest session to expire. It prints how far each browser got and its return peak, then the last 40 `[return-router]` lines of the run from the runner's host (`RETURN_RUNNER_SSH`, default `helix.gaulatti.com`; empty skips them, and they are also skipped where that host cannot be reached). It exits 0 only when every run has a peak above 0 and the guest page said it was playing while audio flowed. When a step fails, the error line carries what the guest page showed: its heading and status text, any alert, and whether Speaker test, Join studio and Leave were enabled. WebKit has no fake-device switch, so a generated camera and microphone are installed on `MediaDevices.prototype` before the page loads (`synthetic-media.mjs`). `return-stats` lists each inbound audio receiver (bytes, packets, `audioLevel`, `totalAudioEnergy`, and whether the return element held it); the peak is the higher of what WebAudio read and that receiver level, since an engine with no sound device may never start WebAudio. With `ALCANTARA_OPERATOR_TOKEN`, each run makes, admits and revokes its own invitation instead. Revoke a console invitation yourself afterwards.

Install the three engines once with `browsers:all`. `return-proof.mjs` runs a single engine (`WEBRTC_BROWSER`), as a phone with `RETURN_DEVICE`.

## On-air proof (`onair-proof.mjs`)

**This puts a tone on the real radio.** Run it only in an agreed window.

```bash
ALCANTARA_INVITATION_PATH=/guest/<token> pnpm --filter @gaulatti/alcantara-e2e onair-proof
```

A guest joins publishing a steady 1 kHz tone (`TONE_HZ`, `TONE_GAIN` 0.2). It prints `WAITING FOR ADMIT`, `WAITING FOR CUE LIVE` and `WAITING FOR WRAP`; an operator does each on `/calls`. It listens to `https://radio.modoitaliano.fm/stream` itself (`ONAIR_STREAM_URL`), discards Icecast's burst of past audio, and measures the tone against the frequencies 40 to 80 Hz beside it in half-second windows. It passes only if the stream did not carry the tone before, carried it in at least 80% of windows while live, and in at most 10% after the wrap, with the guest still connected. It prints the delay from cue to stream, the tone's level and how far it stands above its neighbours.

## Touch regressions (`touch-regressions.mjs`)

Browser checks at 375 × 812 with touch emulation, for the touch fixes that shipped on the frontend (#851, #853, #854, #856, #826). Each check prints one JSON line, and the last line is a summary.

```bash
ALCANTARA_APP_URL=http://localhost:5391 pnpm --filter @gaulatti/alcantara-e2e touch
```

`ALCANTARA_APP_URL` defaults to `http://localhost:5173`, the local Compose frontend. The check needs the seeded data from the dev seed (the radio show's timed block, the legacy-labelled image). The first load of a cold dev server can take a couple of minutes, so the script retries navigation, waits for the app's controls, and reloads once if that first load never finishes. The console's program is shared between runs, so each media check selects its program first. `media-unknown` removes the seeded unknown label, so a second run on the same stack reports it skipped; a fresh stack (`down -v`) passes all seven.

| Check | What it proves | Status |
| --- | --- | --- |
| `library-add` | A Rundown library row's Add button is visible and adds a row by tap (#851) | passes |
| `rotation-move` | Move down reorders a rotation row (#826) | passes |
| `rotation-star` | The high-rotation star is visible without hover (#854) | passes |
| `clear-cue` | An armed cue is cleared by the Clear cue button beside Take (#853) | passes |
| `media-label-row` | A selected label's row controls (Move, Remove) are visible without hover (#854) | passes |
| `media-unknown` | A label the library does not know can be removed and the save goes through (#856) | passes (skipped once its seed label is gone) |
| `timeline-pin-drag` | A timeline pin moves by a touch drag | passes |

A `failed` case exits 1. A `skipped` case is one whose data is absent on the stack, with its reason.

## Console smoke check (`console-smoke.mjs`)

A read-only check of the key console routes in Chromium, signed out, after a deploy. It loads `/` (the console and the radio desk), `/calls`, `/flight` (the rundown) and `/guest` with a token that does not exist. It clicks nothing, uses no credentials, and changes nothing on the server.

A route fails on an uncaught page error, a JavaScript or CSS file that does not load (a request failure or an HTTP status of 400 or more), a blank page, or, for a protected route, no sign-in screen. The sign-in screen is the expected result for the protected routes when signed out, so it passes. One JSON line is printed per route, then a summary. The script exits 1 if any route fails.

```bash
pnpm --filter @gaulatti/alcantara-e2e console-smoke
```

From cumulus, in the Playwright image, the same way as the return proof (`ALCANTARA_APP_URL` defaults to production):

```bash
docker run --rm --init --ipc=host -e ALCANTARA_APP_URL=https://alcantara.gaulatti.com mcr.microsoft.com/playwright:v1.65.0-noble bash -c 'set -e; mkdir /w && cd /w && curl -fsSL https://codeload.github.com/gaulatti/alcantara/tar.gz/main | tar xz --strip-components=1 && npx -y pnpm@9 install --frozen-lockfile --filter @gaulatti/alcantara-e2e >/dev/null && npx -y pnpm@9 --filter @gaulatti/alcantara-e2e console-smoke'
```

`SMOKE_TIMEOUT_MS` (default 60000) bounds each route.

## Console layout pass (`console-layout.mjs`, run by `console-smoke.mjs --layout`)

A signed-in layout check for the console, against the **local** Compose stack only. It refuses any origin that is not `localhost` or `127.0.0.1`, so it cannot run against production, and it signs in with the local test auth of the seeded operator (`/__test/session?identity=operator-a`), never with production credentials.

It joins one stand-in guest through the guest page with fake media, admits it, and then:

- **`/calls`** at 1440×900, 1280×800 and 1024×768: fails if a column has a dead band above the fold longer than 40% of the fold (a stretch where that column is empty while a neighbour has content; space below a column's last element does not count), or if two guest slots overlap. One screenshot per size, in `SMOKE_SHOTS` (default `console-smoke-shots`).
- **The radio desk** (`radio-demo.fm`) at 1440×900 and 1024×768: at 1440, fails if the Guests strip, the mixer or the cartwall is not visible without scrolling; at 1024, fails if any of them is not on the page (below the fold is accepted there). One screenshot per size.

Running it changes only the local stack's data: one invitation, one guest joined and admitted (both removed at the end), and the operator's selected show.

Start the local stack with its test auth and seeded data (see the Compose notes in the repository README), then:

```bash
ALCANTARA_APP_URL=http://localhost:5173 ALCANTARA_API_URL=http://localhost:3000 pnpm --filter @gaulatti/alcantara-e2e console-smoke -- --layout
```

Use the stack's own ports in both URLs if they differ. The default smoke run (no flag) is unchanged and still runs against production.
