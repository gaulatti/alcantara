import {
  AS_RUN_OVERLAP_ALLOWANCE_SECONDS,
  findAsRunAnomalies,
  type AsRunAnomalyRow,
} from './as-run.anomalies';

// gaulatti/alcantara#241: the shapes from 2026-11-21, by their real times.
let id = 0;
const row = (
  state: 'started' | 'ended',
  playbackRequestId: string | null,
  at: string,
  programId = 'p',
): AsRunAnomalyRow => ({
  id: ++id,
  programId,
  songId: 1,
  state,
  at: new Date(`2026-11-21T${at}Z`),
  playbackRequestId,
});

describe('findAsRunAnomalies (#241)', () => {
  it('finds a play that never ended once a later play did, and a long overlap', () => {
    const rows = [
      row('started', 'A507', '05:20:35'),
      row('started', 'B475', '05:23:55'),
      row('ended', 'B475', '05:28:53'),
      row('started', 'C547', '08:10:24'),
      row('started', 'D127', '08:10:33'),
      row('ended', 'C547', '08:14:03'),
      row('ended', 'D127', '08:14:51'),
    ];
    const found = findAsRunAnomalies([...rows].reverse());
    expect(found).toEqual([
      expect.objectContaining({
        kind: 'unended',
        playbackRequestId: 'A507',
        nextStartAt: new Date('2026-11-21T05:23:55Z'),
      }),
      expect.objectContaining({
        kind: 'overlap',
        playbackRequestId: 'D127',
        previousPlaybackRequestId: 'C547',
        overlapSeconds: 210,
      }),
    ]);
  });

  it('accepts a crossfade within the allowance and the open play on air now', () => {
    const rows = [
      row('started', 'A', '06:00:00'),
      row('started', 'B', '06:03:55'),
      row('ended', 'A', '06:04:00'),
      row('ended', 'B', '06:07:00'),
      // C is playing: no later play has ended, so it is not unended.
      row('started', 'C', '06:07:00'),
    ];
    expect(findAsRunAnomalies(rows)).toEqual([]);
    expect(AS_RUN_OVERLAP_ALLOWANCE_SECONDS).toBe(15);
  });

  it('keeps programs apart and skips rows without a play id', () => {
    const rows = [
      row('started', 'X', '01:00:00', 'one'),
      row('started', 'Y', '01:00:00', 'two'),
      row('ended', 'Y', '01:03:00', 'two'),
      row('started', null, '01:01:00', 'one'),
      row('started', 'Z', '01:04:00', 'one'),
    ];
    expect(findAsRunAnomalies(rows)).toEqual([]);
    rows.push(row('ended', 'Z', '01:08:00', 'one'));
    expect(findAsRunAnomalies(rows)).toEqual([
      expect.objectContaining({
        kind: 'unended',
        programId: 'one',
        playbackRequestId: 'X',
      }),
    ]);
  });

  it('orders two starts at the same instant by record id, and cannot call either unended', () => {
    const rows = [
      row('started', 'A', '03:00:00'),
      row('started', 'B', '03:00:00'),
      row('ended', 'B', '03:03:00'),
    ];
    // A play that started at the same instant as the one that ended is not
    // shown to be earlier, so it is not reported.
    expect(findAsRunAnomalies(rows)).toEqual([]);
  });
});
