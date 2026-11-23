/**
 * The program's return feed in a call room (gaulatti/alexandria#9). Two
 * publishers may carry it: the desktop console that renders the program
 * (`desktop-program-feed-<programId>`) and Alana (`program-feed-<programId>`).
 * When the desktop's feed is in the room it is the program; otherwise Alana's.
 */
export const desktopProgramFeed = (programId: string) => `desktop-program-feed-${programId}`;
export const alanaProgramFeed = (programId: string) => `program-feed-${programId}`;

export function isProgramFeed(identity: string, programId: string): boolean {
  return identity === desktopProgramFeed(programId) || identity === alanaProgramFeed(programId);
}

/** The program feed to use, given the identities present in the room. */
export function preferredProgramFeed(programId: string, present: Iterable<string>): string {
  const desktop = desktopProgramFeed(programId);
  for (const identity of present) if (identity === desktop) return desktop;
  return alanaProgramFeed(programId);
}
