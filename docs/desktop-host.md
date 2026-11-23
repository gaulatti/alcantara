# Desktop host (gaulatti/alcantara#431)

The desktop pilot (gaulatti/carmencita) builds **this** frontend; it doesn't keep a copy. It plugs
its desktop-only pieces into one extension point, so any Alcántara fix reaches the desktop when
the pilot bumps its pinned Alcántara commit.

## The contract

`frontend/app/platform/desktopHost.ts` defines `DesktopHost`. Every member is optional:

| Member | Used by | What it does |
|---|---|---|
| `auth.currentSession(forceRefresh)` | `services/session.ts` `getAppSession` | The ID token the desktop app holds, or `null` when signed out |
| `auth.signIn()` | `routes/login.tsx` | Opens the system browser. The result arrives through `onChange` |
| `auth.signOut()` | `services/session.ts` `clearAppSession` | Signs out in the desktop app |
| `auth.onChange(listener)` | `AuthListener`, `routes/login.tsx` | `{ signedIn, error }` after each desktop sign-in or sign-out. Returns an unsubscribe function |
| `topBarControls` | `routes/layout.tsx` | Components rendered after Commands in the top bar, each with the selected `programId` (Go live, Feed, Tape) |
| `programMonitor` | `BroadcastSwitcherDeck` `ConfidenceMonitor` | Shown in the PROGRAM tile instead of the local render, labelled "program source" |

`getDesktopHost()` returns the host or `null`. With `null` (the website), every consumer behaves
exactly as it did before the extension point existed.

## How the host is chosen

The bare specifier `@desktop-host` is an alias:

- In `vite.config.ts`, `vitest.config.ts` and `tsconfig.json`, it resolves to
  `app/platform/desktopHost.none.ts`, whose default export is `null`.
- A desktop build uses a second Vite config that keeps this config and replaces only that alias
  with its own module:

```ts
import { defineConfig, type Alias, type UserConfig } from 'vite';
import base from '<alcantara>/frontend/vite.config';

export default defineConfig(() => {
  const config = base as UserConfig;
  const aliases = (config.resolve?.alias ?? []) as Alias[];
  return {
    ...config,
    resolve: {
      ...config.resolve,
      alias: aliases.map((alias) =>
        String(alias.find) === String(/^@desktop-host$/) ? { ...alias, replacement: '/abs/path/desktop/host.ts' } : alias,
      ),
    },
  };
});
```

Build with `react-router build -c <that config>`. Replace the alias rather than appending to it
(`mergeConfig` appends, and the first match wins).

## Rules

- Alcántara carries no desktop code and no `@tauri-apps/*` dependency. The host module lives in the
  desktop repository and decides for itself when it is active (for example only inside Tauri).
- A new desktop need is a new optional member here, with a test that plugs in a fake host. The
  tests use `vi.mock('@desktop-host', ...)` with a getter, so each test can switch the host on.
