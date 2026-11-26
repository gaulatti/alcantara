# Alcántara - TV Broadcast Overlay Control System

A professional TV broadcast overlay control system built with a modern tech stack.

Alcantara also owns the versioned public-destination decision for each explicit
television Start. The command always follows Alcantara → Alana → Croccante;
only Croccante resolves stream-key-bearing Secrets Manager values. See
[`docs/broadcast-destinations.md`](docs/broadcast-destinations.md) for the
catalog, permission, immutable selection, recovery, and redaction contracts.

## Tech Stack

- **Frontend**: React Router v7 + Vite + Tailwind CSS
- **Backend**: NestJS + Fastify + Prisma
- **Database**: PostgreSQL
- **Monorepo**: pnpm workspace

## Project Structure

```
alcantara/
├── frontend/          # React Router v7 application
│   ├── app/
│   │   ├── routes/
│   │   │   ├── programs.tsx   # Program and template registration
│   │   │   └── control.tsx    # Admin control panel
│   │   └── hooks/
│   │       └── useSSE.ts      # SSE client with auto-reconnect
├── backend/           # NestJS application
│   ├── src/
│   │   ├── program/           # SSE & program state management
│   │   ├── scenes/            # Scene management
│   │   ├── layouts/           # Layout management
│   │   └── prisma.service.ts  # Prisma database client
│   └── prisma/
│       └── schema.prisma      # Database schema
├── compose.yml        # Docker Compose development setup
├── backend/
│   ├── Dockerfile     # Production build
│   └── Dockerfile.dev # Development build (hot reload)
└── frontend/
    ├── Dockerfile     # Production build
    └── Dockerfile.dev # Development build (hot reload)
```

## Features

- Images, audio clips, songs, and transition videos now share a canonical media
  identity while their existing APIs remain compatible during the staged
  migration. See [Media library architecture](docs/media-library-architecture.md).
- Per-song recorded intro assignment, validation, and stable sequence identity
  are documented in [Song intro editorial model](docs/song-intros.md).
- External renderer registration and the versioned manifest boundary are
  documented in [Program template contracts](docs/program-templates.md).
- The proposed managed RTMP/WHIP/HLS/SRT source boundary, local measurements,
  security findings, and phased rollout are documented in
  [ADR 001: LiveKit external-source ingress](docs/adr-001-livekit-external-source-ingress.md).

### Six-guest WebRTC contribution

The Calls console at `/calls` provides six reusable guest slots. An operator
with `alcantara:webrtc:operate` can create a persisted private invitation,
choose its one-to-seven-day lifetime (24 hours by default), copy it, replace or
revoke it, remove its current session, and select the guest's Program, Preview,
or no return video plus Program/Master, monitor, or Aux 1-8 return audio.
Invitation secrets are shown only at creation/replacement; the database stores
only their SHA-256 hash. Guest and operator LiveKit credentials expire after
five minutes and are scoped to one program room. The LiveKit API secret never
enters either browser.

Guests enter `/guest/:invitation` without Cognito, select devices, preview their
camera, test their speaker/network, and confirm headphones before explicitly
joining. A documented acoustic-risk override is available when headphones are
impossible. Each invitation permits one active browser session. A signed
session lease refreshed every 20 seconds preserves the stable slot for a
60-second network-reconnect window; a second browser fails closed. Each refresh
reports the call as it is then: connection quality, return-feed health, and
whether the camera and microphone are on. A rejoin starts from the new room, with
no return feed until it attaches (#672). Revocation
disconnects the guest and prevents future credentials. A join refused as
revoked, expired or invalid (401 or 403) ends the guest's session; any other
refusal (the invitation in use in another window, the studio not ready, a
network or room-connection failure) keeps the preflight and lets the guest
press Join again. A refused camera or microphone permission keeps Join locked.

Operator mute is immediate. Camera/microphone enable is delivered as a request
that the guest accepts or rejects. A media command that names no camera or
microphone is ignored. Standby/live/wrap cues and private messages
persist requested, delivered, acknowledged/read, rejected, or failed state. A
message is marked read as soon as the guest's page shows it and stays on screen
until the guest presses Acknowledge, so operators see read and then
acknowledged. Acknowledge clears the message even when the page has no session
to send the receipt for.
Private talkback publishes only to the target guest's N-1 route and never to the
Program feed. Removing or disconnecting a guest does not mutate Preview or
Program.

Layouts use the `webrtc-guest` component with a generic slot number from 1-6,
not a person or invitation identifier. Assigning a replacement invitation to
the same slot therefore preserves reusable layouts. The normal Preview, CUT,
and TAKE workflow remains the only way a guest reaches air.

#### Return routing

Alana remains the owner of captured Program/Preview output publication. Start
its Program renderer with `?renderer=1` so guest microphones are excluded from
the captured base bus, and publish the output to the matching
`alcantara-<programId>` LiveKit room as `program-feed-<programId>` (and optional
`preview-feed-<programId>`). A desktop console that renders the program itself
publishes it as `desktop-program-feed-<programId>`, with a token from
`POST /webrtc/desktop-program-feed-token` (the program's picture as a screen-share
track and its sound as a microphone-source track named `program-audio`, the only app-audio
track LiveKit's Swift SDK publishes); while that participant is in the
room, guests' program video and the router's program bus take it instead of
`program-feed-<programId>`, and fall back to Alana's feed when it leaves. Run one isolated
`/return-router/<programId>#key=<WEBRTC_RENDERER_KEY>` renderer alongside it.
The fragment is immediately moved to session storage and removed from browser
history; it is never sent in a URL request.

The return router subscribes to the selected processed base bus, connected
guest microphones, and targeted producer talkback. It creates and publishes a
distinct Web Audio destination for every guest, excluding only that guest's
own microphone. Guests subscribe only to their selected video output and their
own `mixminus:<identity>:<bus>` track. This replaces the earlier fixed 250 ms
browser relay and keeps isolated guest tracks out of the guest UI.

Authorized operators can control Alana's independent composed-Program recorder
without treating a requested or finalizing operation as safe media. See
[`docs/program-recording.md`](docs/program-recording.md) for the pinned Alana
contract, state semantics, permissions, idempotency, local fixture, private
configuration, metrics, and recovery boundary.

#### Local and production operations

The production backend also writes a verified, encrypted logical PostgreSQL
backup to the media bucket at the top of every UTC hour. See
[`docs/production-database-backups.md`](docs/production-database-backups.md) for
the recovery boundary, storage path, telemetry, and post-deployment checks.

`docker compose up --build` includes LiveKit 1.13.4 with fixed local-only
credentials and TCP/UDP media ports. Alcantara continues to use its existing
database and Pompeii authorization configuration; this stack does not start a
second Pompeii service. From `/calls`, create six fictional guest
links and open them in separate browser contexts. Chrome's fake-device flags
may be used for repeatable automated media UAT. Verify all six show as connected
without appearing on Preview/Program, assign slots to a reusable layout, then
exercise Preview and TAKE deliberately. Restart one guest and verify its slot
is held for 60 seconds. The machine-only return router requires the local
`WEBRTC_RENDERER_KEY` from Compose. [`e2e/webrtc-call.mjs`](e2e/README.md) runs
the call path as one repeatable check: an operator invitation, a fake-device
guest on the real guest page, the operator and program receiving the guest, and
the guest receiving the program return. It also has a guest-only mode for a
production invitation.

In production, LiveKit runs on Helix, the on-premises host, not on the backend's
service host (#354). `infra/helix/livekit-up.sh` starts it there, and
[`infra/README.md`](infra/README.md) has the ports, the nginx server block and
the one-time host setup. Validate TURN from a restrictive external network
before scheduling remote guests. Never use the committed local credentials
outside Compose.

In production, LiveKit is configured only by the runtime secret
(`broadcast/production/config`, #354). The secret holds four fields that must
all be present or all absent:
- `livekitWsUrl`: the public `wss://` origin;
- `livekitApiKey`;
- `livekitApiSecret`: at least 32 characters;
- `webrtcSessionSecret`: at least 32 characters.

`webrtcRendererKey` is optional.

The backend copies them into `LIVEKIT_WS_URL`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET`, `WEBRTC_SESSION_SECRET` and `WEBRTC_RENDERER_KEY` at
start-up. When a field is absent from the secret, a value left in the container
is removed.

A partial or invalid group never stops the backend, which also controls the
radio. It starts with WebRTC off and logs the field names, never the values.
The deploy's contract check and the LiveKit renderer do refuse such a group, so
a deploy fails before the running container is replaced.

`infra/helix/livekit-up.sh` renders the LiveKit server's `livekit.yaml` from the
same fields (`backend/scripts/print-livekit-config.mjs`) and starts `redis` and
`livekit` on Helix. The backend calls LiveKit's API at the `https://` form of
`livekitWsUrl`, so both go through the same public name.
Without the group, the Calls console reports the feature as unavailable, and
unrelated deployments are unaffected.

### Radio automation

Continuous filler rotation, optional timed content blocks, per-cue browser voice tracks, output confidence, and a prepared Palazzo recovery playlist are documented in [`docs/radio-station-workflow.md`](docs/radio-station-workflow.md).

Radio song sequences default to autoplay when their mode is absent. An explicit
operator choice of Manual remains authoritative. In autoplay, Alcantara advances
to the next playlist item only after Palazzo reports that the active track ended;
looped playlists wrap to the first item and non-looped playlists stop at the end.
Shuffle persists and displays a randomized no-repeat order, advances through it
on the same authoritative Palazzo end events, and wraps only when Loop is on.
Play Next is a separate persisted FIFO queue of playlist references. It never
interrupts the current track. At the next authoritative track end it takes
priority, then Autoplay or Shuffle resumes from the playlist successor that
would have played; Manual remains stopped after the queue drains.
Up to 12 playlist songs can be starred for High Rotation. Automatic playback
opens one High Rotation opportunity every 30 minutes, chooses the least
recently played eligible favorite, and persists authoritative starts across
restarts. The 48 daily opportunities are distributed evenly across the current
favorites, guaranteeing at least four plays per favorite per day: 12 favorites
play four times each, while four favorites play 12 times each. The repeat gap
scales with the pool (`favorite count / 2` hours), avoiding repeats until every
other favorite has had its opportunity. Play Next remains the explicit
operator override, and any queued favorite play counts when choosing the least
recently played song.
The playback bar exposes pressed states for Manual, Autoplay, Shuffle, and Loop
and labels backend playback feedback as live or stale.

The Radio desk includes live Song, Audio clips / bumpers, and Main mixer
controls. Playlist rows can be starred for High Rotation or added to Play Next
without changing playlist order, and the queue supports removal and ordering
before playback. Radio
distribution at `/radio-settings` owns Palazzo automation,
bumper policy, and now-playing consumers so live playout is not mixed with
configuration. Simulcast uses the TV switcher with an explicit radio-leg status
rail. Mixer mutations are applied to Palazzo as well as persisted; bumper
configuration fields are validated and saved by the radio settings API.
All Palazzo traffic is backend-only, restricted to the private broadcast
network and approved origin, and explicitly program-scoped. The shared machine
client preserves playback/idempotency IDs across retries and is also used by
telemetry reconnect and startup recovery.
See [`docs/radio-telemetry.md`](docs/radio-telemetry.md) for the contract,
Secrets Manager bootstrap, allowlisted URLs, failure behavior, and metrics.

### Program output

Alcantara is the program control plane. A program can reference an immutable
template manifest published by Cronkite; the operator UI opens that external
renderer with the program ID and Alcantara API origin from the manifest's
runtime-parameter contract. The legacy `/program/:programId` renderer remains
only as a temporary rollback path until the Fifthbell registration and live
cutover have been verified. See
[Program template contracts](docs/program-templates.md) for registration,
security, state/SSE projection, metrics, and removal gates.

### Control Page (`/control`)

- Mode-aware Bleecker sidebar shell with desktop rail and mobile drawer
- Program/Preview switcher deck with CUT, TAKE, two-step fade-to-black, and
  Director, Audio, and Remote workspaces
- Scene staging separated from Program activation
- Real-time chyron text updates
- Type-aware TV, Radio, and Simulcast operating surfaces
- Manage program state

The complete navigation, surface, safety, responsive, and fixture contract is in
[Operator interface](docs/operator-interface.md).

### Database Schema

**Layouts**: Define reusable component types

- id, name, componentType, settings (JSON)

**Scenes**: Specific configurations using layouts

- id, name, layoutId, chyronText, metadata (JSON)

**ProgramState**: Current active scene (singleton)

- id, activeSceneId, updatedAt

## Getting Started

### Prerequisites

- Docker & Docker Compose

### AWS infrastructure ownership

Macondo provisions the shared Cumulus host, network, and Arauco database. The
service-specific AWS integration lives in [`infra/aws`](infra/aws): Alcántara
owns its GitHub OIDC deployment role, API DNS record, and the policies granting
the Cumulus host access to media storage. Macondo grants its instance
role access to every database secret it provisions; the backend resolves
Arauco credentials inside the container through that instance profile.

### Development

#### Option 1: Using Docker Compose (recommended)

```bash
docker compose up --build
```

This starts PostgreSQL, applies every committed migration non-interactively,
loads deterministic fictional data, and starts the backend, frontend, and
LiveKit. No AWS or Cognito account is needed for local development. Ports are
configurable via `.env`:

- **Backend** (NestJS, default port 3000) with hot reload via `nest start --watch`
- **Frontend** (React Router/Vite, default port 5173) with HMR
- **Broadcast destinations** (`/broadcasts`) with two fictional, version-pinned
  local catalog entries. This exercises the normal API, authorization guards,
  PostgreSQL snapshots, and Alana client boundary.
- **Alana contract fixture** on the private Compose network, used only for local
  destination reload/Start/Stop exercises. It validates authentication,
  sequencing, and exact selection acknowledgement without AWS or public output;
  it is not a deployment or a substitute for production Alana/Croccante proof.

Source directories are mounted so changes are reflected immediately. On Colima a
host edit reaches the container without a file event, so the backend's TypeScript
watcher polls in Compose (`TSC_WATCHFILE` and `TSC_WATCHDIRECTORY` on the `backend`
service, gaulatti/alcantara#600). A saved `backend/src` file restarts the backend:
measured at 2-6 s for a file edited recently and about 15 s for one not edited in a
while (polling slows for files that do not change). The setting is local only: `backend/test/compose-watch-polling.test.js`
fails if the production image, the deploy script or the deploy workflow sets it.

The local stack never reaches real AWS or another real outside service
(gaulatti/alcantara#206):

- **Media store.** Uploads, song and artwork playback, radio recovery audio and
  filler digests use a localstack S3 (`localstack/localstack:4.0.3`, port
  `LOCALSTACK_PORT`, default 4566) with the bucket `alcantara-local-only`,
  created by `infra/localstack-init/01-bucket.sh`. Objects are served at
  `http://localstack.localhost:4566/alcantara-local-only/…`, which the browser
  and the backend both resolve to the host's published port.
- **Credentials.** Compose overrides every AWS name `backend/.env` could hold
  with local placeholders or empty values, does not mount `~/.aws`, and empties
  `ARAUCO_SECRET_ID`, so no Secrets Manager secret is read. The frontend gets
  empty `VITE_COGNITO_*` and `VITE_FQDN`; TEST AUTH needs none of them.
- **Start-up refusal.** Outside production the backend refuses to start when
  `MEDIA_S3_BUCKET` is set without `MEDIA_S3_ENDPOINT`, or when
  `MEDIA_S3_ENDPOINT` or `LOCAL_MEDIA_PUBLIC_BASE_URL` points anywhere but a
  local host (loopback, `*.localhost` or a Compose service name). Production
  refuses to start with either of those two variables set. Each error names the
  variable, never its value.
- **Now-playing and charts.** Outside production no now-playing consumer is
  contacted (Radio settings says so, and the backend logs how many were
  skipped), and the two third-party chart feeds are not polled.
- **Check.** `scripts/check-compose-local.sh` confirms from
  `docker compose config` that every one of these names resolves to its local
  value, without printing any value.

This README is the only description of the local media store; the repository
wiki has no page for it yet.

Local browser authentication is visibly marked `TEST AUTH`. It uses short-lived
tokens with a local-only issuer and these deterministic identities:

- `operator-a` (default) and `operator-b`: normal operator permissions
- `viewer`: read-only, including denial of shared-layout publication

For visual review of the shared login shell, append `?auth-state=` to `/login`
while running the frontend in development. Supported fixtures are `loading`,
`ready`, `submitting`, `failure`, and `authenticated`; production builds ignore
the parameter. The authenticated fixture holds the visible redirect state for
inspection, while a real authenticated session continues immediately to `/`.

Choose an identity before starting or recreating the frontend:

```bash
TEST_AUTH_IDENTITY=viewer docker compose up --build
```

Re-running the backend seed restores deterministic profiles, console presets,
and TV, Radio, and Simulcast workflow fixtures without creating duplicates:

```bash
docker compose exec backend pnpm seed
```

To deliberately erase the disposable local database and replay migrations and
seed data from an empty volume:

```bash
docker compose down -v
docker compose up --build
```

The seeded `radio-demo` songs 9101–9104 have their own fictional tones in the
Compose LocalStack bucket, under `LOCAL_MEDIA_PUBLIC_BASE_URL`, so a fresh stack
can prepare a recovery playlist (gaulatti/alcantara#695). In Radio settings,
**Prepared local playlist** with those songs reaches Palazzo's filler
preparation; without a Palazzo attached, it fails as Palazzo unavailable, not as
a URL refusal. The seeded songs 9001 and 9002 keep their relative
`/fifthbell/audio/` URLs, which the browser plays but Palazzo cannot download,
so they are refused for recovery. The production media guard is unchanged.

The `postgres-data` volume otherwise preserves local changes across restarts.
`AUTH_MODE=test` fails startup under `NODE_ENV=production`; the issuance route
is absent when test auth is disabled, and test tokens use a distinct issuer and
audience that production verification does not accept.

The backend uses the code-owned `host.docker.internal:50087` endpoint while
developing in Compose and the code-owned `api.pompeii.gaulatti.com:443` TLS
endpoint in production with Gaulatti team `1`; no Pompeii endpoint variable is
required.
The browser attaches its current Cognito ID token to every request targeting
Alcantara's configured API origin; requests to external media and data sources
remain unchanged. A backend `401` triggers one forced Cognito session refresh;
if the refreshed request is still unauthorized, Alcantara clears the persisted
browser identity and returns the operator to login.
To populate a slideshow, upload images in the Media library and apply a label to
the required images. Order the label's assets on the Labels tab, then select the
label in the slideshow editor. Existing scenes that still reference a legacy
media group continue to render during migration.

Console preference ownership, device classification, offline behavior,
concurrency, sharing, reset, privacy, and API behavior are documented in
[Operator console preferences](docs/operator-preferences.md).

Rebuild images after dependency changes:

```bash
docker compose up --build
```

Run in background:

```bash
docker compose up -d
```

#### Option 2: Manual launch (without Docker)

```bash
# Terminal 1 - Backend
cd backend
pnpm install && pnpm prisma:generate && pnpm start:dev

# Terminal 2 - Frontend
cd frontend
npm install && npm run dev
```

### Accessing the Application

Ports default to 5173 (frontend) and 3000 (backend). Configure via env vars:

```bash
# Docker: set in ./.env or shell
BACKEND_PORT=3000 VITE_PORT=5173 docker compose up

# Manual dev: set in frontend/.env and backend/.env
```

- **Frontend (dev)**: `http://localhost:<VITE_PORT>` (default 5173)
- **Control Panel**: `http://localhost:<VITE_PORT>/control`
- **Program Page**: `http://localhost:<VITE_PORT>/program`
- **Backend API**: `http://localhost:<BACKEND_PORT>` (default 3000)

### API Endpoints

#### Layouts

- `GET /layouts` - List all layouts
- `POST /layouts` - Create a layout

#### Scenes

- `GET /scenes` - List all scenes
- `GET /scenes/:id` - Get a scene
- `POST /scenes` - Create a scene
- `PUT /scenes/:id/chyron` - Update chyron text

#### Program

- `GET /program/state` - Get current program state
- `POST /program/activate` - Activate a scene
- `GET /program/events` (SSE) - Subscribe to program updates

### Initial Setup

1. Create some layouts via the control panel:
   - Lower Third (componentType: `lower-third`)
   - Full Screen (componentType: `full-screen`)
   - Corner Bug (componentType: `corner-bug`)

2. Create scenes using the layouts

3. Activate scenes and update chyron text from the control panel

4. View the program page to see the live broadcast overlay

## Identity

Alcantara authorizes through Pompeii, which now returns a canonical
`principal_id` alongside the pool subject. Operator preferences, shared console
layouts, guest invitations, and guest lifecycle audit events record it beside
the subject through nullable/additive references; ownership matches the
canonical principal when a row names one and falls back to the pool subject when
it does not, so migrated and unmigrated rows both work during rollout.

Identities are never joined by email, no ownership row changes without a verified
Pompeii mapping, and audit attribution is never rewritten. See
[`docs/canonical-principals.md`](docs/canonical-principals.md) for the inventory,
the dry-run report, and the rollback and reconciliation procedure.

The API accepts only interactive session tokens. The authorization guard
answers `401` with `{"error":"UNAUTHENTICATED","reason":"DENY_UNSUPPORTED_CREDENTIAL"}`
for a bearer whose credential starts with `pmp_pat_` (bare or after a `Bearer`
scheme in any letter case), before any authorization call, and counts it in
`alcantara_auth_refusals_total{reason="unsupported_credential"}`. Every other
bearer is handled exactly as before.

Authorization decisions use one long-lived gRPC channel to Pompeii. A Pompeii
deploy replaces its container, and a connection through the old path can stop
carrying bytes without an error, so calls on it only time out. When an
authorization call ends in `DEADLINE_EXCEEDED` or `UNAVAILABLE`, the backend
replaces the channel (each channel has its own subchannel pool, so the
replacement dials a new connection) and the next call reaches the live Pompeii.
The failed call still answers `503` with
`{"error":"AUTHORIZATION_SERVICE_UNAVAILABLE"}`; nothing is allowed on a
failure. Replacements happen at most once every 5 seconds, so a Pompeii slower
than the deadline is not redialled on every request. Each replacement logs
`Pompeii channel replaced after <reason>` and counts
`alcantara_pompeii_channel_resets_total{reason="deadline_exceeded"|"unavailable"}`
(gaulatti/alcantara#225).

## Architecture

- [Access](docs/access.md) is the page where a signed-in person manages their tokens and, with `alcantara:access:manage`, the token switch and grants; [Access: backend, configuration and metrics](docs/access-api.md) documents its `/access` routes, the optional `POMPEII_ACCESS_CREDENTIAL` secret and `alcantara_access_requests_total`.
- [MCP endpoint](docs/mcp.md) documents `/mcp`, its OAuth discovery documents, who can reach it, and the registered tools.
- [External source registry](docs/external-source-registry.md) documents stable source identity, encrypted transport configuration, SSRF controls, one-time credentials, quotas, lifecycle, and metrics.

Production places the backend on the external `broadcast-control` Docker
network shared with Palazzo and Alana. Before stopping the live backend,
deployment runs
a side-effect-free runtime preflight in the new image to resolve and validate
the approved Palazzo URL and the remaining private-service configuration. The
previous container is retained until the replacement passes its startup check
and is automatically restored if the replacement fails. This keeps the existing
radio controller alive when a configuration or startup defect reaches
deployment. On the Cumulus host, deployment removes only Docker images not
referenced by any running or stopped container before pulling a release and
again after retiring the healthy predecessor. This bounds disk use without
removing the live or rollback image.

Production backend stdout and stderr remain available through `docker logs`,
using Docker's host-local `local` driver with a 10 MiB maximum per file and
three retained files. Alcantara does not require a CloudWatch Logs group or
write grant to start, restart, or roll back. See
[Production backend logging](docs/production-backend-logging.md) for validation
and rollback procedures.

The replacement joins `broadcast-control` so the private
`http://palazzo:3100` program-scoped machine API remains resolvable. Production
uses the code-owned `broadcast/production/config` Secrets Manager payload,
including Alana's private recording control URL and token and the external-source
encryption keyring. The deployment workflow validates that payload without
printing it before image build or push. During migration, deployment also
requires the running Palazzo container on the private `broadcast-control`
network. Palazzo does not require an application credential on this single-host,
single-program boundary. Preflight fails without replacing the live backend
when required configuration is unavailable or invalid.

### Data Flow

```
Control Panel → REST API → Database → SSE Broadcast → Program Page
      │                       ↓
      └── Recording API → private Alana control → composed capture state
                         Program State Update
```

1. Control page sends scene activation/chyron update via REST
2. Backend saves to database
3. Backend broadcasts update via SSE
4. Program page receives SSE event and updates display

### SSE Auto-Reconnect

The frontend SSE client automatically reconnects with a 3-second interval if the connection is lost.

## Development Notes

- Program page dimensions are hardcoded to 1920x1080 (Full HD)
- SSE endpoint uses RxJS observables for broadcasting
- Fastify is used instead of Express for better performance
- Prisma handles database migrations and client generation
- One Node version, stated in `.nvmrc`, runs Compose, CI and the deploy; `backend/test/node-version.test.js` fails when a Dockerfile or workflow differs from it
- The frontend suite also passes inside the Compose frontend service, which holds only `frontend/` and runs with the dev server's `VITE_AUTH_MODE=test`: `docker compose build frontend && docker compose run --rm --no-deps frontend npx vitest run`. The suite starts every test from the provider default (`vitest.config.ts` clears `VITE_AUTH_MODE`); a test that needs TEST AUTH stubs it. Tests that read repository-level files, such as the deploy workflow, belong in `backend/test` and run with `pnpm --dir backend run test:deployment`

## License

MIT

## Clouseau CI

Pull requests run the full verification suite and an exact 100% line/branch
coverage gate for `backend/src`, then automatic Clouseau review, approval and
merge. See [`docs/clouseau-ci.md`](docs/clouseau-ci.md), the
[review contract](.github/clouseau.md) and the
[configuration](.github/clouseau.json). The frontend, `infra/aws` and
`backend/scripts` are outside the exact gate for now; their tests still run.
