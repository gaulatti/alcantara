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
