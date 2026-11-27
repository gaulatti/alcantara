# End-to-end browser checks

Checks that drive a real browser against a running Alcántara.

## WebRTC guest call (`webrtc-call.mjs`, alcantara#354)

One run proves the whole call path:

1. An operator creates a guest invitation through the API.
2. A synthetic **desktop program feed** joins as `desktop-program-feed-<program>` and publishes a moving test picture as a screen share, as the pilot's Feed does.
3. A guest opens the real **guest page** (`/guest/<token>`) in Chromium with a fake camera and microphone (`--use-fake-device-for-media-stream`). It plays the speaker test, ticks "I am wearing headphones" and presses "Join studio". The guest runs **signed out**, as in production, where the sign-in library answers a session with no ID token; in its own browser context the local test-auth session is answered the same way. A fetch wrapper that needed a token once stopped every production guest's join (#847).
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
| `ALCANTARA_PROGRAM_ID` | The program whose call room is used (default `main`). |
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
