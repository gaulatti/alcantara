/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method, @typescript-eslint/require-await -- Jest mocks are intentionally loosely typed. */
import { Logger } from '@nestjs/common';
import {
  AudioAnalysisError,
  type AudioAnalysis,
} from './ffmpeg-audio.analyzer';
import {
  ANALYSIS_TIMEOUT_MS,
  BUSY_GAP_MS,
  IDLE_POLL_MS,
  LEASE_MS,
  MediaAnalysisService,
  START_DELAY_MS,
} from './media-analysis.service';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const URL_A = 'https://bucket.s3.amazonaws.com/songs/a.mp3';
const ROW_UPDATED_AT = new Date('2026-11-17T11:00:00.000Z');

const ANALYSIS: AudioAnalysis = {
  durationSeconds: 240,
  cueInSeconds: 1.5,
  cueOutSeconds: 238,
  integratedLufs: -14.2,
  truePeakDbtp: -0.8,
  isrc: 'USRC17607839',
  musicbrainzRecordingId: null,
};

const EMPTY = {
  cueInSeconds: null,
  cueOutSeconds: null,
  fadeInSeconds: null,
  fadeOutSeconds: null,
  overlapSeconds: null,
  integratedLufs: null,
  truePeakDbtp: null,
  isrc: null,
  musicbrainzRecordingId: null,
};

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    assetId: 'song:1',
    sourceUrl: URL_A,
    analysisUpdatedAt: null,
    attempts: null,
    sourceChanged: false,
    ...overrides,
  };
}

function setup(rows: unknown[][] = [[candidate()]]) {
  const queue = [...rows];
  const prisma = {
    $queryRaw: jest.fn(async () => queue.shift() ?? []),
    mediaAssetAnalysis: {
      create: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const metrics = { record: jest.fn() };
  const analyzer = {
    available: jest.fn(async () => true),
    analyze: jest.fn(async () => ANALYSIS),
  };
  const service = new MediaAnalysisService(
    prisma as never,
    metrics as never,
    analyzer as never,
  );
  return { service, prisma, metrics, analyzer };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('MediaAnalysisService.runOnce', () => {
  it('selects the newest audio asset that is unanalysed, stale or due, by the clock it is given', async () => {
    const { service, prisma, analyzer } = setup([[]]);

    await expect(service.runOnce(NOW)).resolves.toBe(false);

    const [query] = prisma.$queryRaw.mock.calls[0] as unknown as [
      { sql: string; values: unknown[] },
    ];
    expect(query.sql).toContain(`WHERE a."mediaType" = 'AUDIO'`);
    expect(query.sql).toContain('m."assetId" IS NULL');
    expect(query.sql).toContain('m."sourceUrl" IS DISTINCT FROM a."sourceUrl"');
    expect(query.sql).toContain('m."nextAttemptAt" <= CAST(');
    expect(query.sql).toContain('ORDER BY a."createdAt" DESC');
    expect(query.sql).toContain('LIMIT 1');
    expect(query.values).toEqual([NOW.toISOString()]);
    expect(analyzer.analyze).not.toHaveBeenCalled();
    expect(prisma.mediaAssetAnalysis.create).not.toHaveBeenCalled();
  });

  it('claims a new asset, analyses it with the per-file timeout and stores a success', async () => {
    const { service, prisma, analyzer, metrics } = setup();

    await expect(service.runOnce(NOW)).resolves.toBe(true);

    expect(prisma.mediaAssetAnalysis.create).toHaveBeenCalledWith({
      data: {
        assetId: 'song:1',
        status: 'pending',
        attempts: 1,
        nextAttemptAt: new Date(NOW.getTime() + LEASE_MS),
        sourceUrl: URL_A,
      },
    });
    expect(analyzer.analyze).toHaveBeenCalledWith(URL_A, ANALYSIS_TIMEOUT_MS);
    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenCalledWith({
      where: { assetId: 'song:1', sourceUrl: URL_A, status: 'pending' },
      data: {
        status: 'success',
        cueInSeconds: 1.5,
        cueOutSeconds: 238,
        fadeInSeconds: null,
        fadeOutSeconds: null,
        overlapSeconds: null,
        integratedLufs: -14.2,
        truePeakDbtp: -0.8,
        isrc: 'USRC17607839',
        musicbrainzRecordingId: null,
        error: null,
        nextAttemptAt: null,
      },
    });
    expect(metrics.record).toHaveBeenCalledWith('success', expect.any(Number));
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it('writes the same row when the same file is analysed again', async () => {
    const first = setup();
    const second = setup([
      [
        candidate({
          analysisUpdatedAt: ROW_UPDATED_AT,
          attempts: 1,
          sourceChanged: true,
        }),
      ],
    ]);
    await first.service.runOnce(NOW);
    await second.service.runOnce(NOW);

    const lastWrite = (calls: unknown[][]) => calls[calls.length - 1];
    expect(
      lastWrite(second.prisma.mediaAssetAnalysis.updateMany.mock.calls),
    ).toEqual(lastWrite(first.prisma.mediaAssetAnalysis.updateMany.mock.calls));
  });

  it('marks a failed run failed with no measurement and retries after the backoff', async () => {
    const { service, prisma, analyzer, metrics } = setup();
    analyzer.analyze.mockRejectedValueOnce(new AudioAnalysisError('timeout'));

    await service.runOnce(NOW);

    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenLastCalledWith({
      where: { assetId: 'song:1', sourceUrl: URL_A, status: 'pending' },
      data: {
        status: 'failed',
        ...EMPTY,
        error: 'timeout',
        nextAttemptAt: new Date(NOW.getTime() + 5 * 60_000),
      },
    });
    expect(metrics.record).toHaveBeenCalledWith('retry', expect.any(Number));
    expect(Logger.prototype.warn).toHaveBeenCalledWith({
      event: 'media_analysis.failed',
      assetId: 'song:1',
      result: 'retry',
      error: 'timeout',
    });
  });

  it('claims a due retry only if the row is unchanged, and backs off longer the second time', async () => {
    const { service, prisma, analyzer } = setup([
      [candidate({ analysisUpdatedAt: ROW_UPDATED_AT, attempts: 1 })],
    ]);
    analyzer.analyze.mockRejectedValueOnce(new Error('unexpected'));

    await service.runOnce(NOW);

    expect(prisma.mediaAssetAnalysis.create).not.toHaveBeenCalled();
    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenNthCalledWith(1, {
      where: { assetId: 'song:1', updatedAt: ROW_UPDATED_AT },
      data: {
        status: 'pending',
        attempts: 2,
        nextAttemptAt: new Date(NOW.getTime() + LEASE_MS),
        sourceUrl: URL_A,
      },
    });
    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          error: 'decode-failed',
          nextAttemptAt: new Date(NOW.getTime() + 30 * 60_000),
        }),
      }),
    );
  });

  it('makes the failure final after the third run', async () => {
    const { service, prisma, analyzer, metrics } = setup([
      [candidate({ analysisUpdatedAt: ROW_UPDATED_AT, attempts: 2 })],
    ]);
    analyzer.analyze.mockRejectedValueOnce(
      new AudioAnalysisError('decode-failed'),
    );

    await service.runOnce(NOW);

    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ attempts: 3 }),
      }),
    );
    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          nextAttemptAt: null,
        }),
      }),
    );
    expect(metrics.record).toHaveBeenCalledWith('failure', expect.any(Number));
  });

  it('does not retry a failure that a second run cannot change', async () => {
    const { service, prisma, analyzer, metrics } = setup();
    analyzer.analyze.mockRejectedValueOnce(new AudioAnalysisError('silent'));

    await service.runOnce(NOW);

    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ error: 'silent', nextAttemptAt: null }),
      }),
    );
    expect(metrics.record).toHaveBeenCalledWith('failure', expect.any(Number));
  });

  it('restarts the run count when the asset now has another source', async () => {
    const { service, prisma } = setup([
      [
        candidate({
          analysisUpdatedAt: ROW_UPDATED_AT,
          attempts: 3,
          sourceChanged: true,
        }),
      ],
    ]);

    await service.runOnce(NOW);

    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ attempts: 1, sourceUrl: URL_A }),
      }),
    );
    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'success' }),
      }),
    );
  });

  it('settles a last run that never finished as failed, without analysing again', async () => {
    const { service, prisma, analyzer, metrics } = setup([
      [candidate({ analysisUpdatedAt: ROW_UPDATED_AT, attempts: 3 })],
    ]);

    await service.runOnce(NOW);

    expect(analyzer.analyze).not.toHaveBeenCalled();
    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenCalledWith({
      where: { assetId: 'song:1', updatedAt: ROW_UPDATED_AT },
      data: {
        status: 'failed',
        ...EMPTY,
        error: 'interrupted',
        nextAttemptAt: null,
        sourceUrl: URL_A,
      },
    });
    expect(metrics.record).toHaveBeenCalledWith('failure', expect.any(Number));
  });

  it('records nothing when another instance settled the interrupted run first', async () => {
    const { service, prisma, metrics } = setup([
      [candidate({ analysisUpdatedAt: ROW_UPDATED_AT, attempts: 3 })],
    ]);
    prisma.mediaAssetAnalysis.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.runOnce(NOW)).resolves.toBe(true);
    expect(metrics.record).not.toHaveBeenCalled();
  });

  it('skips an asset another instance claimed first', async () => {
    const created = setup();
    created.prisma.mediaAssetAnalysis.create.mockRejectedValueOnce(
      new Error('Unique constraint failed'),
    );
    await expect(created.service.runOnce(NOW)).resolves.toBe(true);
    expect(created.analyzer.analyze).not.toHaveBeenCalled();

    const updated = setup([
      [candidate({ analysisUpdatedAt: ROW_UPDATED_AT, attempts: 1 })],
    ]);
    updated.prisma.mediaAssetAnalysis.updateMany.mockResolvedValueOnce({
      count: 0,
    });
    await updated.service.runOnce(NOW);
    expect(updated.analyzer.analyze).not.toHaveBeenCalled();
    expect(updated.metrics.record).not.toHaveBeenCalled();
  });

  it('fails a source that is not an http or https URL without running a tool', async () => {
    for (const sourceUrl of ['file:///etc/passwd', 'not a url']) {
      const { service, prisma, analyzer, metrics } = setup([
        [candidate({ sourceUrl })],
      ]);

      await service.runOnce(NOW);

      expect(analyzer.analyze).not.toHaveBeenCalled();
      expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenLastCalledWith({
        where: { assetId: 'song:1', sourceUrl, status: 'pending' },
        data: {
          status: 'failed',
          ...EMPTY,
          error: 'unsupported-source',
          nextAttemptAt: null,
        },
      });
      expect(metrics.record).toHaveBeenCalledWith(
        'failure',
        expect.any(Number),
      );
    }
  });

  it('accepts a plain http source', async () => {
    const sourceUrl = 'http://localhost:9000/a.mp3';
    const { service, analyzer } = setup([[candidate({ sourceUrl })]]);
    await service.runOnce(NOW);
    expect(analyzer.analyze).toHaveBeenCalledWith(
      sourceUrl,
      ANALYSIS_TIMEOUT_MS,
    );
  });

  it('never writes to the asset itself', async () => {
    const { service, prisma, analyzer } = setup();
    analyzer.analyze.mockRejectedValueOnce(
      new AudioAnalysisError('decode-failed'),
    );
    await service.runOnce(NOW);
    expect(Object.keys(prisma)).toEqual(['$queryRaw', 'mediaAssetAnalysis']);
  });

  it('runs one analysis at a time', async () => {
    const { service, analyzer } = setup([
      [candidate()],
      [candidate({ assetId: 'song:2' })],
    ]);
    let release!: (value: AudioAnalysis) => void;
    analyzer.analyze.mockImplementationOnce(
      () => new Promise<AudioAnalysis>((resolve) => (release = resolve)),
    );

    const first = service.runOnce(NOW);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(service.runOnce(NOW)).resolves.toBe(false);
    release(ANALYSIS);
    await expect(first).resolves.toBe(true);
    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
    await expect(service.runOnce()).resolves.toBe(true);
  });
});

describe('MediaAnalysisService schedule', () => {
  it('is not scheduled when ffmpeg or ffprobe is missing', async () => {
    jest.useFakeTimers();
    const { service, analyzer, prisma } = setup();
    analyzer.available.mockResolvedValueOnce(false);

    await service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(START_DELAY_MS * 10);

    expect(analyzer.available).toHaveBeenCalledWith(10_000);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Media analysis is not scheduled: ffmpeg or ffprobe is not installed',
    );
  });

  it('starts after the startup delay, keeps going while there is work and idles when there is none', async () => {
    jest.useFakeTimers();
    const { service, prisma } = setup([
      [candidate()],
      [candidate({ assetId: 'song:2' })],
    ]);

    await service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(START_DELAY_MS - 1);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(BUSY_GAP_MS);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(BUSY_GAP_MS);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(IDLE_POLL_MS - 1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);

    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(IDLE_POLL_MS * 2);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it('keeps polling after a run fails before analysing', async () => {
    jest.useFakeTimers();
    const { service, prisma } = setup();
    prisma.$queryRaw.mockRejectedValueOnce(new Error('database unavailable'));

    await service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(START_DELAY_MS);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Media analysis run failed before analysing a file',
    );
    await jest.advanceTimersByTimeAsync(IDLE_POLL_MS);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });

  it('stops cleanly when destroyed before it was scheduled, or while a run is in flight', async () => {
    jest.useFakeTimers();
    const idle = setup();
    expect(() => idle.service.onModuleDestroy()).not.toThrow();

    const busy = setup();
    let release!: (value: AudioAnalysis) => void;
    busy.analyzer.analyze.mockImplementationOnce(
      () => new Promise<AudioAnalysis>((resolve) => (release = resolve)),
    );
    await busy.service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(START_DELAY_MS);
    busy.service.onModuleDestroy();
    release(ANALYSIS);
    await jest.advanceTimersByTimeAsync(IDLE_POLL_MS * 2);
    expect(busy.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
