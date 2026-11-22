import { Prisma } from '@prisma/client';
import { AsRunService } from './as-run.service';
import { RadioMetricsService } from '../radio/radio-metrics.service';
import type { PrismaService } from '../prisma.service';

// gaulatti/alcantara#241: a play whose end never arrived (it ended while the
// backend was down) is closed once a later play ends, at the next play's start.

type Row = {
  id: number;
  programId: string;
  songId: number | null;
  assetId: string | null;
  state: string;
  at: Date;
  playbackRequestId: string | null;
  inferred: boolean;
  reviewFlag: string | null;
  endReason: string | null;
};
type Range = { gte?: Date; lte?: Date; lt?: Date; gt?: Date };

function table() {
  const rows: Row[] = [];
  const matchValue = (actual: unknown, wanted: unknown): boolean => {
    if (wanted && typeof wanted === 'object' && !(wanted instanceof Date)) {
      const w = wanted as { not?: unknown; in?: unknown[] } & Range;
      if ('not' in w) return actual !== w.not;
      if ('in' in w) return (w.in ?? []).includes(actual);
      const at = actual as Date;
      return (
        (!w.gte || at >= w.gte) &&
        (!w.lte || at <= w.lte) &&
        (!w.lt || at < w.lt) &&
        (!w.gt || at > w.gt)
      );
    }
    return actual === wanted;
  };
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) =>
      matchValue(row[key as keyof Row], value),
    );
  const ordered = (list: Row[]) =>
    [...list].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id);
  const prisma = {
    asRunRecord: {
      create: jest.fn(({ data }: { data: Omit<Row, 'id'> }) => {
        if (
          rows.some(
            (r) =>
              r.programId === data.programId &&
              r.playbackRequestId === data.playbackRequestId &&
              r.state === data.state,
          )
        )
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError(
              'Unique constraint failed',
              {
                code: 'P2002',
                clientVersion: 'test',
              },
            ),
          );
        const row: Row = {
          songId: null,
          assetId: null,
          inferred: false,
          reviewFlag: null,
          endReason: null,
          ...data,
          id: rows.length + 1,
        } as Row;
        rows.push(row);
        return Promise.resolve(row);
      }),
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          ordered(rows.filter((r) => matches(r, where)))[0] ?? null,
        ),
      ),
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(ordered(rows.filter((r) => matches(r, where)))),
      ),
    },
    song: { findFirst: jest.fn(() => Promise.resolve(null)) },
    mediaAsset: { findFirst: jest.fn(() => Promise.resolve(null)) },
  };
  return { rows, prisma };
}

const t = (hhmmss: string) => new Date(`2026-11-21T${hhmmss}Z`);

describe('as-run plays whose end never arrived (#241)', () => {
  const setup = (bootedAt = '09:00:00') => {
    const store = table();
    const metrics = new RadioMetricsService();
    const service = new AsRunService(
      store.prisma as unknown as PrismaService,
      undefined,
      metrics,
    );
    // The fixtures are on 2026-11-21: this process "started" just after them.
    (service as unknown as { bootedAt: number }).bootedAt =
      t(bootedAt).getTime();
    const warn = jest
      .spyOn(service['logger'], 'warn')
      .mockImplementation(() => undefined);
    const event = (
      type: 'track.started' | 'track.ended',
      id: string,
      at: string,
    ) =>
      service.handleTrackEvent({
        programId: 'p',
        type,
        playbackRequestId: id,
        at: t(at),
        title: null,
        artist: null,
        url: null,
      } as never);
    const endOf = (id: string) =>
      store.rows.find((r) => r.playbackRequestId === id && r.state === 'ended');
    return { store, metrics, service, warn, event, endOf };
  };

  it('closes the play that was on air when the backend stopped, at the next start, once a later play ends', async () => {
    const s = setup('05:24:30');
    // 05:20:35 A starts; its end is lost while the backend restarts.
    await s.event('track.started', 'A', '05:20:35');
    // 05:23:55 B starts (adopted after the restart) and ends normally.
    await s.event('track.started', 'B', '05:23:55');
    expect(s.endOf('A')).toBeUndefined();
    await s.event('track.ended', 'B', '05:28:53');

    expect(s.endOf('A')).toMatchObject({
      at: t('05:23:55'),
      inferred: true,
      reviewFlag: 'unended',
    });
    expect(s.endOf('B')).toMatchObject({ inferred: false, reviewFlag: null });
    expect(s.warn).toHaveBeenCalledTimes(1);
    expect(s.warn.mock.calls[0][0]).toMatch(/never received its end/);
    expect(s.metrics.render()).toMatch(
      /alcantara_radio_log_transitions_total\{result="unended-closed"\} 1/,
    );
  });

  // gaulatti/alcantara#272, 2026-11-22: a backend-only restart while Palazzo
  // handed off alone. The engine now records the track it did not command as an
  // inferred start at Palazzo's reported time; when it ends, the previous play
  // (whose end was lost) closes at that start, flagged for review.
  it('closes the previous play at the inferred start of a track the engine inherited', async () => {
    const s = setup('05:24:30');
    await s.event('track.started', 'A', '05:20:35');
    await s.service.handleTrackEvent({
      programId: 'p',
      type: 'track.started',
      playbackRequestId: 'INHERITED',
      at: t('05:23:55'),
      inferred: true,
      title: null,
      artist: null,
      url: null,
    } as never);
    expect(
      s.store.rows.find((r) => r.playbackRequestId === 'INHERITED'),
    ).toMatchObject({
      state: 'started',
      inferred: true,
    });
    await s.event('track.ended', 'INHERITED', '05:28:53');
    expect(s.endOf('A')).toMatchObject({
      at: t('05:23:55'),
      inferred: true,
      reviewFlag: 'unended',
    });
    expect(s.endOf('INHERITED')).toMatchObject({ inferred: false });
  });

  it('leaves a crossfaded predecessor alone: it ends before the next does', async () => {
    const s = setup();
    await s.event('track.started', 'A', '06:00:00');
    // B starts under A's last seconds (overlap); A's real end follows.
    await s.event('track.started', 'B', '06:03:55');
    await s.event('track.ended', 'A', '06:04:00');
    await s.event('track.ended', 'B', '06:07:00');
    expect(s.endOf('A')).toMatchObject({ at: t('06:04:00'), inferred: false });
    expect(s.store.rows.filter((r) => r.reviewFlag === 'unended')).toEqual([]);
    expect(s.warn).not.toHaveBeenCalled();
  });

  it('closes each of several unended plays at the start that followed it, once', async () => {
    const s = setup('01:09:00');
    await s.event('track.started', 'A', '00:24:45');
    await s.event('track.started', 'B', '01:04:24');
    await s.event('track.started', 'C', '01:09:15');
    await s.event('track.ended', 'C', '01:14:16');
    expect(s.endOf('A')?.at).toEqual(t('01:04:24'));
    expect(s.endOf('B')?.at).toEqual(t('01:09:15'));
    // A later end does not close them again.
    await s.event('track.started', 'D', '01:14:18');
    await s.event('track.ended', 'D', '01:16:52');
    expect(
      s.store.rows.filter(
        (r) => r.state === 'ended' && r.reviewFlag === 'unended',
      ),
    ).toHaveLength(2);
  });

  it('leaves open plays that started over an hour before this process started to the listing', async () => {
    const s = setup();
    // 07:59 is more than an hour before the 09:00 boot: history, untouched.
    await s.event('track.started', 'HISTORY', '07:59:00');
    // 08:10 is within the hour before boot: the play on air at the restart.
    await s.event('track.started', 'ONAIR', '08:10:00');
    await s.event('track.started', 'NEXT', '09:01:00');
    await s.event('track.ended', 'NEXT', '09:04:00');
    expect(s.endOf('HISTORY')).toBeUndefined();
    expect(s.endOf('ONAIR')).toMatchObject({
      at: t('09:01:00'),
      reviewFlag: 'unended',
    });
  });

  it('ignores plays older than the look-back and ends without a recorded start', async () => {
    const s = setup();
    await s.event('track.started', 'OLD', '00:00:00');
    s.store.rows[0].at = new Date(
      t('00:00:00').getTime() - 25 * 60 * 60 * 1000,
    );
    await s.event('track.ended', 'NOSTART', '02:00:00');
    await s.event('track.started', 'B', '03:00:00');
    await s.event('track.ended', 'B', '03:04:00');
    expect(s.endOf('OLD')).toBeUndefined();
    expect(await s.service.closeUnendedEarlierPlays('p', 'missing')).toBe(0);
  });

  it('does not write a second end when the real end lands first', async () => {
    const s = setup();
    await s.event('track.started', 'A', '07:00:00');
    await s.event('track.started', 'B', '07:03:00');
    await s.event('track.ended', 'B', '07:06:00');
    // A's real end arrives late: one end per play, so the close stands.
    await s.event('track.ended', 'A', '07:02:59');
    expect(
      s.store.rows.filter(
        (r) => r.playbackRequestId === 'A' && r.state === 'ended',
      ),
    ).toHaveLength(1);
  });

  it('absorbs a concurrent close of the same play and surfaces any other failure', async () => {
    const s = setup();
    await s.event('track.started', 'A', '08:00:00');
    await s.event('track.started', 'B', '08:03:00');
    s.store.prisma.asRunRecord.create.mockImplementationOnce(() =>
      Promise.reject(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      ),
    );
    expect(await s.service.closeUnendedEarlierPlays('p', 'B')).toBe(0);
    expect(s.warn).not.toHaveBeenCalled();
    s.store.prisma.asRunRecord.create.mockImplementationOnce(() =>
      Promise.reject(new Error('database down')),
    );
    await expect(s.service.closeUnendedEarlierPlays('p', 'B')).rejects.toThrow(
      'database down',
    );
    expect(await s.service.closeUnendedEarlierPlays('p', 'B')).toBe(1);
  });

  it('records the real end and never rejects when the close fails', async () => {
    const s = setup('05:24:30');
    const error = jest
      .spyOn(s.service['logger'], 'error')
      .mockImplementation(() => undefined);
    await s.event('track.started', 'A', '05:20:35');
    await s.event('track.started', 'B', '05:23:55');
    // The close's first read fails; the real end of B must still be written.
    const findMany = s.store.prisma.asRunRecord.findMany;
    findMany.mockImplementationOnce(() =>
      Promise.reject(new TypeError('database down')),
    );
    await expect(
      s.event('track.ended', 'B', '05:28:53'),
    ).resolves.toMatchObject({ state: 'ended', playbackRequestId: 'B' });
    expect(s.endOf('B')).toMatchObject({ at: t('05:28:53'), inferred: false });
    expect(s.endOf('A')).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe(
      'Closing unended as-run plays on p failed (TypeError)',
    );
    expect(s.metrics.render()).toMatch(
      /alcantara_radio_log_transitions_total\{result="unended-close-failed"\} 1/,
    );
    // A non-Error value is named by its type.
    findMany.mockImplementationOnce(() => Promise.reject('down'));
    await s.event('track.started', 'C', '05:29:00');
    await s.event('track.ended', 'C', '05:32:00');
    expect(error.mock.calls[1][0]).toMatch(/failed \(string\)$/);
  });
});
