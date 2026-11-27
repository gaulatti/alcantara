/**
 * What this device may play out loud while the host microphone is open (gaulatti/alcantara#879). The browser cannot
 * tell speakers from headphones, so every pre-fade listen and local preview is muted by default; an operator on
 * headphones says so once, and this device remembers it. The broadcast monitor stays muted either way (RadioMonitor).
 */
const KEY = "alcantara.preFadeOnHeadphones";

function stored(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "yes";
  } catch {
    return false;
  }
}

let micLive = false;
// Read on first use: there is no window while the page is rendered on a server.
let headphones: boolean | null = null;
const elements = new Set<HTMLMediaElement>();
const listeners = new Set<() => void>();

export const onHeadphones = (): boolean => (headphones ??= stored());
export const preFadeMuted = (): boolean => micLive && !onHeadphones();

function apply(): void {
  for (const element of elements) element.muted = preFadeMuted();
  for (const listener of listeners) listener();
}

export function subscribeLocalAudio(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Every pre-listen and preview element is held here while it sounds; the returned call lets it go. */
export function holdLocalAudio(element: HTMLMediaElement): () => void {
  elements.add(element);
  element.muted = preFadeMuted();
  return () => void elements.delete(element);
}

export function setHostMicLive(live: boolean): void {
  if (live === micLive) return;
  micLive = live;
  apply();
}

export function setOnHeadphones(value: boolean): void {
  headphones = value;
  try {
    window.localStorage.setItem(KEY, value ? "yes" : "no");
  } catch {
    // Not remembered on this device; it holds for this page.
  }
  apply();
}

/** For tests: back to a closed microphone and nothing remembered in memory. */
export function resetLocalAudio(): void {
  micLive = false;
  headphones = null;
  elements.clear();
  listeners.clear();
}
