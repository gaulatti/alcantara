# Alcántara - TV Broadcast Overlay Control System

A professional TV broadcast overlay control system built with a modern tech stack.

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

- Per-song recorded intro assignment, validation, and stable sequence identity
  are documented in [Song intro editorial model](docs/song-intros.md).
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
credentials and TCP/UDP media ports. Alcantara continues to use its existing
database and Pompeii authorization configuration; this stack does not start a
second Pompeii service. From `/calls`, create six fictional guest
links and open them in separate browser contexts. Chrome's fake-device flags
may be used for repeatable automated media UAT. Verify all six show as connected
without appearing on Preview/Program, assign slots to a reusable layout, then
exercise Preview and TAKE deliberately. Restart one guest and verify its slot
is held for 60 seconds. The machine-only return router requires the local
`WEBRTC_RENDERER_KEY` from Compose.

Production owns LiveKit, Redis, TLS, TURN/TLS, firewall rules, health checks,
and secrets through Alcantara deployment infrastructure. Start from
`infra/livekit.production.example.yaml`, generate real API/session/renderer
secrets in the application-scoped secret. Route public LiveKit HTTPS/WSS through
the existing port-443 edge, and expose WebRTC TCP 7881, TURN/TLS 5349, TURN UDP
3478, and the configured UDP media/relay ranges. Validate TURN
from a restrictive external network before scheduling remote guests. Never use
the committed local credentials outside Compose. The Calls console reports the
feature as unavailable until `LIVEKIT_CONFIG_B64`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET`, `WEBRTC_SESSION_SECRET`, `WEBRTC_RENDERER_KEY`, and the
public `LIVEKIT_WS_URL` deployment variable are configured; their absence does
not block unrelated Alcantara deployments.

### Radio automation

Radio song sequences default to autoplay when their mode is absent. An explicit
operator choice of Manual remains authoritative. In autoplay, Alcantara advances
to the next playlist item only after Palazzo reports that the active track ended;
looped playlists wrap to the first item and non-looped playlists stop at the end.

The radio control surface includes live Song, Instants / bumpers, and Main
mixer controls. Mixer mutations are applied to Palazzo as well as persisted;
bumper configuration fields are validated and saved by the radio settings API.

### Program Page (`/program`)

- Fixed 1920x1080 Full HD resolution (hardcoded, not responsive)
- Real-time updates via SSE
- Auto-reconnecting SSE client
- Supports multiple layout types:
  - Lower Third
  - Full Screen
  - Corner Bug

### Control Page (`/control`)

- Program/Preview switcher deck with CUT, TAKE, fade-to-black, and workspace modes
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

The backend uses the code-owned `host.docker.internal:50087` endpoint while
developing in Compose and the code-owned `api.pompeii.gaulatti.com:443` TLS
endpoint in production with Gaulatti team `1`; no Pompeii endpoint variable is
required.
The browser attaches its current Cognito ID token to every request targeting
Alcantara's configured API origin; requests to external media and data sources
remain unchanged. A backend `401` triggers one forced Cognito session refresh;
if the refreshed request is still unauthorized, Alcantara clears the persisted
browser identity and returns the operator to login.
To populate a slideshow, select its media group on the Media Groups tab, switch
to Media Library, and use each image's add-to-group action. The selected group
and its ordered membership remain active across the tab switch.

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

Production places the backend on the external `broadcast-control` Docker
network shared with Palazzo. The backend deployment verifies that the network
exists before replacing the live container, then joins the replacement to it so
the private `http://palazzo:3100` telemetry endpoint remains resolvable across
deployments.

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
