# Alcántara - TV Broadcast Overlay Control System

A professional TV broadcast overlay control system built with a modern tech stack.

## Tech Stack

- **Frontend**: React Router v7 + Vite + Tailwind CSS
- **Backend**: NestJS + Fastify + Prisma
- **Database**: SQLite
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

### Program Page (`/program`)

- Fixed 1920x1080 Full HD resolution (hardcoded, not responsive)
- Real-time updates via SSE
- Auto-reconnecting SSE client
- Supports multiple layout types:
  - Lower Third
  - Full Screen
  - Corner Bug

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
