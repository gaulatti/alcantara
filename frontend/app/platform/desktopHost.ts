import type { ComponentType } from "react";
import host from "@desktop-host";

/**
 * gaulatti/alcantara#431: the one place a desktop app plugs into this frontend. The website
 * resolves `@desktop-host` to `desktopHost.none.ts` (no host). The desktop pilot
 * (gaulatti/carmencita) builds this same frontend with a second Vite config that points the
 * alias at its own module, so Alcántara never carries desktop code and every Alcántara fix
 * reaches the desktop by bumping one pinned ref. Every member is optional.
 */
export interface DesktopSessionResult {
  token: string;
  userSub?: string;
  payload?: Record<string, unknown>;
}

/** What the desktop app reports when a sign-in or sign-out completes. */
export interface DesktopAuthChange {
  signedIn: boolean;
  error: string | null;
}

export interface DesktopHost {
  /** The desktop app signs in through the system browser and keeps the tokens. */
  auth?: {
    currentSession(forceRefresh: boolean): Promise<DesktopSessionResult | null>;
    signIn(): Promise<void>;
    signOut(): Promise<void>;
    /** Called when a desktop sign-in or sign-out completes; returns an unsubscribe. */
    onChange(listener: (change: DesktopAuthChange) => void): () => void;
  };
  /** Extra controls at the end of the console's top bar (for example Go live, Feed, Tape). */
  topBarControls?: Array<ComponentType<{ programId: string }>>;
  /** Shown in the PROGRAM tile instead of the local render: the program's own picture. */
  programMonitor?: ComponentType<{ programId: string }>;
}

export function getDesktopHost(): DesktopHost | null {
  return host;
}
