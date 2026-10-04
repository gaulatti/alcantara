import type { FlightCue, SongCatalogItem } from "../models/broadcast";
export function rundownTiming(
  items: FlightCue[],
  songs: Pick<SongCatalogItem, "id" | "durationMs">[],
) {
  let cursor: number | null = 0;
  return items.map((cue, index) => {
    if (cue.clockOffsetSeconds !== undefined)
      cursor = cue.clockOffsetSeconds * 1000;
    const duration =
      cue.kind === "stopSong"
        ? 0
        : cue.kind === "playSong"
          ? songs.find((song) => song.id === cue.songId)?.durationMs
          : cue.durationMs;
    if (
      duration === undefined ||
      duration === null ||
      (duration <= 0 && cue.kind !== "stopSong")
    )
      cursor = null;
    else if (cursor !== null) cursor += duration;
    const next = items[index + 1];
    const boundary = next?.clockOffsetSeconds ?? (next ? undefined : 3600);
    return {
      durationMs: duration,
      gapMs:
        boundary !== undefined && cursor !== null
          ? Math.max(0, boundary * 1000 - cursor)
          : null,
      cutMs:
        boundary !== undefined && cursor !== null
          ? Math.max(0, cursor - boundary * 1000)
          : null,
    };
  });
}
