# Quick Start Guide

## Installation

```bash
# Install all dependencies
pnpm install
```

## Initial Setup

The database has already been seeded with sample data:
- 3 layouts (Lower Third, Full Screen, Corner Bug)
- 3 scenes (Breaking News, Welcome, Live Indicator)
- 1 program state (no active scene)

## Running the Application

### Option 1: Using tmux (Recommended)

```bash
./launch.sh
```

This will open a tmux session with one `dev` window split into two panes:
- Left pane: Backend (NestJS on port 3000)
- Right pane: Frontend (Vite dev server on port 5173)

If your session is messy or you want to rebuild the split layout:

```bash
./launch.sh --reset
```

To detach from tmux: `Ctrl+B` then `D`
To reattach: `tmux attach -t alcantara`
To kill the session: `tmux kill-session -t alcantara`

### Option 2: Manual Launch

```bash
# Terminal 1 - Backend
cd backend
pnpm start:dev

# Terminal 2 - Frontend
cd frontend
pnpm dev
```

## Using the System

### 1. Open the Control Panel
Visit: http://localhost:5173/control

Here you can:
- View all available scenes
- Activate a scene (click on it)
- Update chyron text for the active scene
- Create new scenes and layouts

### 2. Open the Program Page
Visit: http://localhost:5173/program

This page displays:
- Fixed 1920x1080 resolution
- Currently active scene
- Real-time updates via SSE

### 3. Test the System

1. In the control panel, click on "Breaking News" to activate it
2. Watch the program page update in real-time
3. Enter new text in the "Update Chyron Text" field and click "Update"
4. Watch the program page update the text immediately
5. Try switching between different scenes

## Architecture Overview

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│  Control Panel  │────────>│   NestJS API     │────────>│  Program Page   │
│  (localhost:    │  REST   │  (localhost:     │   SSE   │  (localhost:    │
│   5173/control) │         │   3000)          │         │   5173/program) │
└─────────────────┘         └──────────────────┘         └─────────────────┘
                                     │
                                     ▼
                            ┌──────────────────┐
                            │  SQLite Database │
                            │  (prisma/dev.db) │
                            └──────────────────┘
```

## API Endpoints

### Layouts
- `GET /layouts` - List all layouts
- `GET /layouts/component-types` - Get available component types
- `GET /layouts/:id` - Get layout by ID
- `POST /layouts` - Create layout
  ```json
  {
    "name": "My Layout",
    "componentType": "lower-third",
    "settings": {}
  }
  ```
- `PUT /layouts/:id` - Update layout
  ```json
  {
    "name": "Updated Name",
    "componentType": "full-screen"
  }
  ```
- `DELETE /layouts/:id` - Delete layout

### Scenes
- `GET /scenes` - List all scenes
- `GET /scenes/:id` - Get scene by ID
- `POST /scenes` - Create scene
  ```json
  {
    "name": "My Scene",
    "layoutId": 1,
    "chyronText": "Hello World"
  }
  ```
- `PUT /scenes/:id` - Update scene
  ```json
  {
    "name": "Updated Scene",
    "layoutId": 2,
    "chyronText": "Updated Text"
  }
  ```
- `PUT /scenes/:id/chyron` - Update chyron text only
  ```json
  {
    "chyronText": "Updated Text"
  }
  ```
- `DELETE /scenes/:id` - Delete scene (auto-clears from program if active)

### Program
- `GET /program/state` - Get current program state
- `POST /program/activate` - Activate a scene
  ```json
  {
    "sceneId": 1
  }
  ```
- `GET /program/events` (SSE) - Subscribe to real-time updates
  - Event types: `scene_change`, `scene_update`, `chyron_update`, `scene_cleared`

## Component Types

The system supports three built-in layout types:

1. **lower-third**: Text overlay at the bottom of the screen
2. **full-screen**: Full-screen text display
3. **corner-bug**: Small text badge in the top-right corner

## Database Management

### Reset Database
```bash
cd backend
npx prisma migrate reset
pnpm seed
```

### View Database
```bash
cd backend
npx prisma studio
```

### Create Migration
```bash
cd backend
npx prisma migrate dev --name <migration_name>
```

## Troubleshooting

### Port Already in Use
If port 3000 or 5173 is already in use:

Backend (port 3000):
- Edit `backend/src/main.ts` and change the port number
- Update frontend API calls to use the new port

Frontend (port 5173):
- Edit `frontend/vite.config.ts` and add:
  ```ts
  server: { port: 5174 }
  ```

### Database Locked Error
If you get a "database is locked" error:
```bash
cd backend
rm prisma/dev.db
npx prisma migrate dev
pnpm seed
```

### SSE Connection Issues
- Check that CORS is enabled in the backend
- Verify the backend is running on port 3000
- Check browser console for connection errors

## Next Steps

1. Customize the layout components in [frontend/app/routes/program.tsx](frontend/app/routes/program.tsx)
2. Add new layout types by creating new components
3. Enhance the control panel UI in [frontend/app/routes/control.tsx](frontend/app/routes/control.tsx)
4. Add authentication and authorization
5. Deploy to production

Enjoy your TV broadcast overlay control system!
