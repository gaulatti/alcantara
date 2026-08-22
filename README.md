# Alcántara - TV Broadcast Overlay Control System

A professional TV broadcast overlay control system built with a modern tech stack.

## Self-contained local development

From this repository, `docker compose up --build` starts Alcantara PostgreSQL,
Pompeii PostgreSQL, both migration paths, deterministic fictional seeds,
Pompeii authorization, self-hosted LiveKit, the Alcantara backend, and the frontend. The only
one-time prerequisite is a sibling checkout at `../pompeii`; no Cognito, AWS,
cloud database, production secret, or host process is used.

The browser signs in automatically as the wildcard administrator and shows a
`TEST AUTH` banner. Select another deterministic profile at startup with
`VITE_TEST_AUTH_PROFILE=viewer|manager|operator|denied|admin docker compose up --build`.
Every profile receives a 15-minute local token and still traverses Alcantara's
normal bearer-token guard and Pompeii gRPC authorization decision.

Local Compose uses the committed PostgreSQL baseline under
`backend/prisma/local-migrations`; the older historical directory contains
SQLite-era SQL and is not executed against the local PostgreSQL service.

To destroy only this Compose project's local databases and reseed from empty
volumes, run `docker compose down --volumes` followed by
`docker compose up --build`. The seed operation is idempotent and runs on every
start after Pompeii migrations complete.

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
│   │   │   ├── program.tsx    # TV display page (1920x1080 fixed)
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
60-second network-reconnect window; a second browser fails closed. Revocation
disconnects the guest and prevents future credentials.

Operator mute is immediate. Camera/microphone enable is delivered as a request
that the guest accepts or rejects. Standby/live/wrap cues and private messages
persist requested, delivered, acknowledged/read, rejected, or failed state.
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
`preview-feed-<programId>`). Run one isolated
`/return-router/<programId>#key=<WEBRTC_RENDERER_KEY>` renderer alongside it.
The fragment is immediately moved to session storage and removed from browser
history; it is never sent in a URL request.

The return router subscribes to the selected processed base bus, connected
guest microphones, and targeted producer talkback. It creates and publishes a
distinct Web Audio destination for every guest, excluding only that guest's
own microphone. Guests subscribe only to their selected video output and their
own `mixminus:<identity>:<bus>` track. This replaces the earlier fixed 250 ms
browser relay and keeps isolated guest tracks out of the guest UI.

#### Local and production operations

`docker compose up --build` includes LiveKit 1.13.4 with fixed local-only
credentials and TCP/UDP media ports. From `/calls`, create six fictional guest
links and open them in separate browser contexts. Chrome's fake-device flags
may be used for repeatable automated media UAT. Verify all six show as connected
without appearing on Preview/Program, assign slots to a reusable layout, then
exercise Preview and TAKE deliberately. Restart one guest and verify its slot
is held for 60 seconds. The machine-only return router requires the local
`WEBRTC_RENDERER_KEY` from Compose.

Production owns LiveKit, Redis, TLS, TURN/TLS, firewall rules, health checks,
and secrets through Alcantara deployment infrastructure. Start from
`infra/livekit.production.example.yaml`, generate real API/session/renderer
secrets in the application-scoped secret, and expose HTTPS/TURN 443, WebRTC TCP
7881, TURN UDP 3478, and the configured UDP media/relay ranges. Validate TURN
from a restrictive external network before scheduling remote guests. Never use
the committed local credentials outside Compose.

### Program Page (`/program`)

- Fixed 1920x1080 Full HD resolution (hardcoded, not responsive)
- Real-time updates via SSE
- Auto-reconnecting SSE client
- Supports multiple layout types:
  - Lower Third
  - Full Screen
  - Corner Bug

#### Transitional renderer boundary (G-118)

The Alana-owned Program renderer remains a trusted machine-runtime client while
machine authentication is extracted in G-119. Alcantara exposes only the
following renderer HTTP surface without an operator bearer token:

| Direction  | Route                                                             | Renderer purpose                |
| ---------- | ----------------------------------------------------------------- | ------------------------------- |
| Read       | `GET /program/broadcast-settings`                                 | Audio and timing bootstrap      |
| Read       | `GET /program/:programId/state` and legacy `GET /program/state`   | Active scene and Program state  |
| Read       | `GET /program/:programId/audio-bus`                               | Audio-bus bootstrap             |
| Read/write | `GET`/`POST /program/:programId/audio-meter`                      | Meter snapshot and telemetry    |
| Read       | `GET /program/:programId/scene-instant`                           | Scene-instant playback restore  |
| Read/write | `GET`/`POST /program/:programId/song-playback`                    | Song playback state             |
| Read       | `GET /program/audio-proxy`                                        | Same-origin renderer audio      |
| Read       | `GET /program/:programId/media-groups`                            | Program media-group assignments |
| Read       | `GET /program/:programId/stingers`                                | Program stinger preload         |
| Read       | `SSE /program/:programId/events` and legacy `SSE /program/events` | Program event stream            |
| Read       | `GET /media-groups/:id`                                           | Active slideshow media          |
| Read       | `GET /charts/sanremo-realtime`                                    | Renderer chart data             |

The renderer WebSocket connects to
`/program/ws?programId=<id>&role=program`. It may send only
`audio_meter_update`, `song_playback_update`, and `song_ended`. The role never
receives operator snapshots or operator event broadcasts, and all other inbound
message types are rejected. Operator REST and realtime access continues through
Cognito plus Pompeii permissions; `role=control` also requires a protected,
single-use realtime ticket.

This is an explicitly transitional trust boundary: the renderer role is
self-declared and its two telemetry/playback writes are unauthenticated. Keep
the renderer URL and runtime network exposure limited to the deployed broadcast
environment until G-119 replaces this with machine authentication. Public
guest/WebRTC endpoints are separate from this boundary and are unchanged.

### Control Page (`/control`)

- Scene selection and activation
- Real-time chyron text updates
- Create new scenes and layouts
- Manage program state

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

### Development

#### Option 1: Using Docker Compose (recommended)

```bash
docker compose up
```

This builds and starts both services (ports configurable via `.env`):
- **Backend** (NestJS, default port 3000) with hot reload via `nest start --watch`
- **Frontend** (React Router/Vite, default port 5173) with HMR

Source directories are mounted so changes are reflected immediately.

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

## Architecture

### Data Flow

```
Control Panel → REST API → Database → SSE Broadcast → Program Page
                              ↓
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

## License

MIT
