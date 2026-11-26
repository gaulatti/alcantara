/**
 * How much of a timed block's content is cut at its fixed starts (#788, MCP parity item 3): the rule the
 * rundown desk shows in red and asks about before publishing (frontend rundownTiming and timelineLayout).
 * From each fixed start, content plays for its stored lengths; when it runs past the next fixed start, the
 * excess is cut there. A stretch with a cue of unknown length is not counted, since its end is unknown, and
 * generated fillers are expected to be cut, so they never count as an overrun.
 */
export interface OverrunCue {
  kind: string;
  songId?: number;
  durationMs?: number;
  clockOffsetSeconds?: number;
  isFiller?: boolean;
}

export function rundownOverrunMs(
  items: OverrunCue[],
  songDurations: ReadonlyMap<number, number | null>,
): number {
  let cursor: number | null = 0;
  let overrun = 0;
  items.forEach((cue, index) => {
    if (cue.clockOffsetSeconds !== undefined)
      cursor = cue.clockOffsetSeconds * 1000;
    const duration =
      cue.kind === 'stopSong'
        ? 0
        : cue.kind === 'playSong'
          ? typeof cue.songId === 'number'
            ? songDurations.get(cue.songId)
            : undefined
          : cue.durationMs;
    if (
      duration === undefined ||
      duration === null ||
      (duration <= 0 && cue.kind !== 'stopSong')
    )
      cursor = null;
    else if (cursor !== null) cursor += duration;
    const boundary = items[index + 1]?.clockOffsetSeconds;
    if (boundary === undefined || cursor === null || cue.isFiller) return;
    overrun += Math.max(0, cursor - boundary * 1000);
  });
  return overrun;
}

/** "01:05" for 65 s, as the rundown desk writes a length (formatRundownDuration). */
export function formatOverrun(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
