/**
 * Which build of the console is running here, and which one is deployed now (gaulatti/alcantara#879). The build's
 * identity is React Router's manifest version: the loaded page exposes it, and the served index.html names it in its
 * `/assets/manifest-<version>.js`. Both are null when they cannot be read, so nothing is ever guessed.
 */

const MANIFEST = /\/assets\/manifest-([A-Za-z0-9_-]+)\.js/;

/** The build this page was loaded from. */
export function runningBuild(scope: { __reactRouterManifest?: { version?: unknown } } = window as never): string | null {
  const version = scope.__reactRouterManifest?.version;
  return typeof version === "string" && version ? version : null;
}

/** The build the site serves now, read from a fresh copy of its index page. */
export async function deployedBuild(fetchImpl: typeof fetch = fetch, origin = window.location.origin): Promise<string | null> {
  try {
    const response = await fetchImpl(`${origin}/`, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) return null;
    return MANIFEST.exec(await response.text())?.[1] ?? null;
  } catch {
    return null;
  }
}
