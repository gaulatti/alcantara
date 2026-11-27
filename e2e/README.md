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

## Program return proof (`return-proof-all.mjs`)

A guest joins the real guest page in Chromium, WebKit and Firefox, one after another, and the level of the return that page plays is measured. Nothing else is opened, so sound means the server's return router delivered it. It defaults to production and `modoitaliano.fm`.

```bash
ALCANTARA_INVITATION_PATH=/guest/<token> pnpm --filter @gaulatti/alcantara-e2e return-proof
```

Make the invitation in `/calls`. Each time `WAITING FOR ADMIT <browser>` is printed, press **Admit** within 180 seconds. Between browsers it waits 70 seconds for the previous guest session to expire. It prints how far each browser got and its return peak, then the last 40 `[return-router]` lines of the run from the runner's host (`RETURN_RUNNER_SSH`, default `helix.gaulatti.com`; empty skips them, and they are also skipped where that host cannot be reached). It exits 0 only when all three have a peak above 0. When a step fails, the error line carries what the guest page showed: its heading and status text, any alert, and whether Speaker test, Join studio and Leave were enabled. WebKit has no fake-device switch, so a generated camera and microphone are installed on `MediaDevices.prototype` before the page loads (`synthetic-media.mjs`). `return-stats` lists each inbound audio receiver (bytes, packets, `audioLevel`, `totalAudioEnergy`, and whether the return element held it); the peak is the higher of what WebAudio read and that receiver level, since an engine with no sound device may never start WebAudio. With `ALCANTARA_OPERATOR_TOKEN`, each run makes, admits and revokes its own invitation instead. Revoke a console invitation yourself afterwards.

Install the three engines once with `browsers:all`. `return-proof.mjs` runs a single engine (`WEBRTC_BROWSER`).

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
