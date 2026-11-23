/**
 * gaulatti/alcantara#241: a read-only check of the as-run log for the two
 * shapes a backend restart left behind. The rows are read by
 * scripts/list-as-run-anomalies.mjs; nothing here writes.
 */

export type AsRunAnomalyRow = {
  id: number;
  programId: string;
  songId: number | null;
  state: string;
  at: Date;
  playbackRequestId: string | null;
};

export type AsRunAnomaly =
  | {
      kind: 'unended';
      programId: string;
      recordId: number;
      playbackRequestId: string;
      songId: number | null;
      startedAt: Date;
      /** The next play's start, by when it had ended. */
      nextStartAt: Date;
    }
  | {
      kind: 'overlap';
      programId: string;
      recordId: number;
      playbackRequestId: string;
      songId: number | null;
      startedAt: Date;
      previousPlaybackRequestId: string;
      previousEndedAt: Date;
      /** How long both were on air. */
      overlapSeconds: number;
    };

/**
 * A crossfade starts the next song under the end of the current one; longer
 * than this is two songs on air (Palazzo's overlap is a few seconds).
 */
export const AS_RUN_OVERLAP_ALLOWANCE_SECONDS = 15;

/**
 * Finds, per program, plays that started but never ended while a later play
 * did (`unended`), and plays that started more than the allowance before the
 * previous play's end (`overlap`). Rows may come in any order.
 */
export function findAsRunAnomalies(rows: AsRunAnomalyRow[]): AsRunAnomaly[] {
  const anomalies: AsRunAnomaly[] = [];
  const byProgram = new Map<string, AsRunAnomalyRow[]>();
  for (const row of rows) {
    if (!row.playbackRequestId) continue;
    const list = byProgram.get(row.programId) ?? [];
    list.push(row);
    byProgram.set(row.programId, list);
  }
  for (const [programId, list] of byProgram) {
    const starts = list
      .filter((r) => r.state === 'started')
      .sort((a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id);
    const ends = new Map(
      list
        .filter((r) => r.state === 'ended')
        .map((r) => [r.playbackRequestId as string, r.at]),
    );
    const lastEndedStart = starts.reduce<Date | null>(
      (latest, s) =>
        ends.has(s.playbackRequestId as string) && (!latest || s.at > latest)
          ? s.at
          : latest,
      null,
    );
    starts.forEach((start, index) => {
      const id = start.playbackRequestId as string;
      // A later play ended, so a later start exists: the next one.
      if (!ends.has(id) && lastEndedStart && start.at < lastEndedStart) {
        anomalies.push({
          kind: 'unended',
          programId,
          recordId: start.id,
          playbackRequestId: id,
          songId: start.songId,
          startedAt: start.at,
          nextStartAt: starts[index + 1].at,
        });
      }
      const previous = index > 0 ? starts[index - 1] : null;
      const previousEnd = previous
        ? ends.get(previous.playbackRequestId as string)
        : undefined;
      if (previous && previousEnd) {
        const overlapSeconds =
          (previousEnd.getTime() - start.at.getTime()) / 1000;
        if (overlapSeconds > AS_RUN_OVERLAP_ALLOWANCE_SECONDS) {
          anomalies.push({
            kind: 'overlap',
            programId,
            recordId: start.id,
            playbackRequestId: id,
            songId: start.songId,
            startedAt: start.at,
            previousPlaybackRequestId: previous.playbackRequestId as string,
            previousEndedAt: previousEnd,
            overlapSeconds,
          });
        }
      }
    });
  }
  return anomalies;
}
