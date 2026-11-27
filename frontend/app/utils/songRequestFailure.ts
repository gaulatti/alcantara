/**
 * A song Palazzo could not load (`song_request_failed`, gaulatti/alcantara#175):
 * the operator's one-line notice, or null for anything else.
 */
export function songRequestFailureNotice(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (e.type !== "song_request_failed") return null;
  const title =
    typeof e.title === "string" && e.title.trim() ? e.title.trim() : "A song";
  const artist =
    typeof e.artist === "string" && e.artist.trim() ? ` by ${e.artist.trim()}` : "";
  const reason =
    e.reason === "timeout" ? "it took too long to load" : "it could not be loaded";
  return `“${title}”${artist} did not play: ${reason}. The next song played instead.`;
}

/** Palazzo restarted under a song (`playout_restart_cut`): where it was cut, or null for anything else. */
export function playoutCutNotice(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (e.type !== "playout_restart_cut" || typeof e.cutAtMs !== "number") return null;
  const seconds = Math.max(0, Math.floor(e.cutAtMs / 1000));
  const title = typeof e.title === "string" && e.title.trim() ? e.title.trim() : "A song";
  return `Playout restarted: song cut at ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}. “${title}” was not resumed.`;
}
