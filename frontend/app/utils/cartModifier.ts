// Platform-aware cart modifier (gaulatti/alcantara#308). On macOS a cart plays on
// Ctrl+letter, which is free there because the copy and paste shortcuts use Cmd.
// On Windows and Linux Ctrl+C/V/X/Z/A/F/P belong to the browser and the OS, so a
// cart uses Alt+letter instead. The platform is read once and cached.

export type PlatformNavigator = {
  userAgentData?: { platform?: string };
  platform?: string;
};

export type ChordEvent = Pick<KeyboardEvent, "ctrlKey" | "altKey" | "metaKey" | "shiftKey">;

let cachedIsMac: boolean | undefined;

/** True for an Apple platform. userAgentData.platform first, then navigator.platform. */
export function isMacPlatform(nav: PlatformNavigator | undefined = globalThis.navigator): boolean {
  const platform = nav?.userAgentData?.platform ?? nav?.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** The platform decision, read once per page and reused. */
export function platformIsMac(): boolean {
  if (cachedIsMac === undefined) cachedIsMac = isMacPlatform();
  return cachedIsMac;
}

/** Test seam: forget the cached platform so the next read sees a stubbed one. */
export function resetPlatformForTests(): void {
  cachedIsMac = undefined;
}

/** True when the event carries this platform's cart modifier and no other modifier. */
export function cartModifierHeld(event: ChordEvent, isMac: boolean): boolean {
  if (event.metaKey || event.shiftKey) return false;
  return isMac ? event.ctrlKey && !event.altKey : event.altKey && !event.ctrlKey;
}

/** The chord a cart's key cap shows for this platform, e.g. "Ctrl+Q" or "Alt+Q". */
export function cartChordLabel(letter: string, isMac: boolean): string {
  return `${isMac ? "Ctrl" : "Alt"}+${letter}`;
}
