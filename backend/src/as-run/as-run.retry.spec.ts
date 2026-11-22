/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access -- Jest mocks are intentionally loosely typed. */
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Subject } from 'rxjs';
import { AsRunService } from './as-run.service';
import type { AsRunTrackEvent } from './as-run.types';
import type { PrismaService } from '../prisma.service';
import type { RadioMetricsService } from '../radio/radio-metrics.service';
import type { SongExecutionEngine } from '../radio/song-execution.engine';

const event = (
  programId: string,
  type: AsRunTrackEvent['type'],
  playbackRequestId: string,
): AsRunTrackEvent => ({
  programId,
  type,
  playbackRequestId,
  title: 'Fictional title',
  artist: 'Fictional artist',
  url: 'https://cdn.example.test/a.mp3',
  at: new Date('2026-11-21T01:00:00Z'),
});

describe('AsRunService record retry (#256)', () => {
  const rows: Array<{
    programId: string;
    playbackRequestId: string;
    state: string;
  }> = [];
  let create: jest.Mock;
  let recordRadioLogResult: jest.Mock;
  let subject: Subject<AsRunTrackEvent>;
  let service: AsRunService;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    rows.length = 0;
    create = jest.fn(({ data }) => {
      rows.push(data);
      return Promise.resolve({ id: rows.length, ...data });
    });
    const prisma = {
      asRunRecord: {
        create,
        findFirst: jest.fn(({ where }) =>
          Promise.resolve(
            rows.find(
              (r) =>
                r.programId === where.programId &&
                r.playbackRequestId === where.playbackRequestId &&
                r.state === where.state,
            )
              ? { id: 1 }
              : null,
          ),
        ),
      },
      song: { findFirst: jest.fn().mockResolvedValue(null) },
      mediaAsset: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    recordRadioLogResult = jest.fn();
    subject = new Subject<AsRunTrackEvent>();
    service = new AsRunService(
      prisma as unknown as PrismaService,
      {
        trackEvents$: subject.asObservable(),
      } as unknown as SongExecutionEngine,
      { recordRadioLogResult } as unknown as RadioMetricsService,
    );
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
    warn.mockRestore();
    jest.useRealTimers();
  });

  const settle = () => jest.advanceTimersByTimeAsync(5000);

  it('writes exactly one row after a transient failure', async () => {
    create.mockRejectedValueOnce(new Error('connection reset'));
    subject.next(event('p1', 'track.started', 'r1'));
    await settle();
    expect(rows).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(recordRadioLogResult).not.toHaveBeenCalled();
  });

  it('counts a permanent failure once, warns by state only, and does not block the next event', async () => {
    create.mockRejectedValueOnce(new Error('down'));
    create.mockRejectedValueOnce(new Error('down'));
    create.mockRejectedValueOnce(new Error('down'));
    create.mockRejectedValueOnce(new Error('down'));
    subject.next(event('p1', 'track.started', 'r1'));
    subject.next(event('p1', 'track.started', 'r2'));
    await settle();
    expect(recordRadioLogResult).toHaveBeenCalledTimes(1);
    expect(recordRadioLogResult).toHaveBeenCalledWith('record-failed');
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('started');
    expect(message).not.toContain('Fictional');
    expect(rows.map((r) => r.playbackRequestId)).toEqual(['r2']);
  });

  it('names an ended state and tolerates a non-Error rejection', async () => {
    create.mockRejectedValue('down');
    subject.next(event('p1', 'track.ended', 'r1'));
    await settle();
    expect(String(warn.mock.calls[0][0])).toContain('ended');
    expect(String(warn.mock.calls[0][0])).toContain('string');
    expect(recordRadioLogResult).toHaveBeenCalledWith('record-failed');
  });

  it('counts completed and closes unended plays once when an ended write is retried', async () => {
    const closeUnended = jest
      .spyOn(service, 'closeUnendedEarlierPlays')
      .mockResolvedValue(0);
    create.mockRejectedValueOnce(new Error('blip'));
    create.mockRejectedValueOnce(new Error('blip'));
    subject.next(event('p1', 'track.ended', 'r1'));
    await settle();
    expect(create).toHaveBeenCalledTimes(3);
    expect(recordRadioLogResult.mock.calls).toEqual([['completed']]);
    expect(closeUnended).toHaveBeenCalledTimes(1);
  });

  it('keeps one row when the same event is delivered twice', async () => {
    subject.next(event('p1', 'track.started', 'r1'));
    subject.next(event('p1', 'track.started', 'r1'));
    await settle();
    expect(rows).toHaveLength(1);
  });

  it('treats a concurrent duplicate (P2002) as success, not a failure', async () => {
    create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    subject.next(event('p1', 'track.started', 'r1'));
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(recordRadioLogResult).not.toHaveBeenCalled();
  });

  it('keeps arrival order per program while a retry is pending, and does not hold other programs', async () => {
    create.mockRejectedValueOnce(new Error('blip'));
    subject.next(event('p1', 'track.started', 'r1'));
    subject.next(event('p1', 'track.ended', 'r1'));
    subject.next(event('p2', 'track.started', 'r9'));
    await jest.advanceTimersByTimeAsync(10);
    expect(rows.map((r) => `${r.programId}:${r.state}`)).toEqual([
      'p2:started',
    ]);
    await settle();
    expect(rows.map((r) => `${r.programId}:${r.state}`)).toEqual([
      'p2:started',
      'p1:started',
      'p1:ended',
    ]);
  });
});
