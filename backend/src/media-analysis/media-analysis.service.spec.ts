/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method, @typescript-eslint/require-await -- Jest mocks are intentionally loosely typed. */
import { Logger } from '@nestjs/common';
import {
  AudioAnalysisError,
  FfmpegAudioAnalyzer,
  type AudioAnalysis,
} from './ffmpeg-audio.analyzer';
import {
  ANALYSIS_TIMEOUT_MS,
  dutyCycleWaitMs,
  DUTY_CYCLE_MULTIPLE,
  MAX_WAIT_MS,
  MIN_WAIT_MS,
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
    remaining: BigInt(1),
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
  const metrics = { record: jest.fn(), setBacklog: jest.fn() };
  const analyzer = {
    available: jest.fn(async () => true),
    lowPriority: true,
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
    expect(query.sql).toContain('COUNT(*) OVER () AS "remaining"');
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
    await jest.advanceTimersByTimeAsync(MIN_WAIT_MS - 1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(MIN_WAIT_MS);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(IDLE_POLL_MS - 1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);

    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(IDLE_POLL_MS * 2);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it('starts no earlier than five minutes after boot and says whether it runs niced', async () => {
    jest.useFakeTimers();
    expect(START_DELAY_MS).toBe(5 * 60_000);
    const niced = setup();
    await niced.service.onApplicationBootstrap();
    expect(Logger.prototype.log).toHaveBeenCalledWith(
      'Media analysis is scheduled at lowered priority',
    );
    niced.service.onModuleDestroy();

    const plain = setup();
    plain.analyzer.lowPriority = false;
    await plain.service.onApplicationBootstrap();
    expect(Logger.prototype.log).toHaveBeenCalledWith(
      'Media analysis is scheduled; nice is not installed, so it runs at normal priority',
    );
    plain.service.onModuleDestroy();
  });

  it('waits the duty-cycle multiple of a run that failed, as of one that succeeded', async () => {
    jest.useFakeTimers();
    const { service, prisma, analyzer } = setup([
      [candidate()],
      [candidate({ assetId: 'song:2' })],
    ]);
    analyzer.analyze.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      throw new AudioAnalysisError('decode-failed');
    });

    await service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(START_DELAY_MS);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
    await jest.advanceTimersByTimeAsync(30_000 - 1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });

  it('survives a refused remote source: the row fails with a bounded code and the next asset is analysed', async () => {
    jest.useFakeTimers();
    const PRIVATE_URL = 'https://inside.example.com/songs/b.mp3';
    const { prisma, metrics } = setup([
      [candidate({ assetId: 'song:2', sourceUrl: PRIVATE_URL })],
      [candidate()],
    ]);
    const run = jest.fn(async (command: string, args: string[]) => {
      if (args.includes('-version')) return { stdout: '', stderr: '' };
      return command === 'ffprobe' || args.includes('ffprobe')
        ? { stdout: JSON.stringify({ streams: [{}], format: {} }), stderr: '' }
        : {
            stdout: 'out_time_us=200000000\nprogress=end\n',
            stderr: [
              '[silencedetect @ 0x2] silence_start: 0',
              '[silencedetect @ 0x2] silence_end: 1 | silence_duration: 1',
              '[Parsed_ebur128_1 @ 0x1] Summary:',
              '',
              '  Integrated loudness:',
              '    I:         -14.0 LUFS',
              '',
              '  True peak:',
              '    Peak:       -1.0 dBFS',
              '',
            ].join('\n'),
          };
    });
    const recorded: string[] = [];
    const analyzer = new FfmpegAudioAnalyzer(run, {
      resolve: async (hostname) => [
        {
          address:
            hostname === 'inside.example.com' ? '10.0.0.8' : '52.216.8.1',
          family: 4,
        },
      ],
      record: (_path, result) => recorded.push(result),
    });
    const service = new MediaAnalysisService(
      prisma as never,
      metrics as never,
      analyzer,
    );

    await service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(START_DELAY_MS);
    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenLastCalledWith({
      where: { assetId: 'song:2', sourceUrl: PRIVATE_URL, status: 'pending' },
      data: {
        status: 'failed',
        ...EMPTY,
        error: 'source-refused',
        nextAttemptAt: null,
      },
    });
    expect(metrics.record).toHaveBeenCalledWith('failure', expect.any(Number));
    const toolRuns = () =>
      run.mock.calls.filter(([, args]) => !args.includes('-version'));
    expect(toolRuns()).toEqual([]);
    expect(Logger.prototype.warn).toHaveBeenCalledWith({
      event: 'media_analysis.failed',
      assetId: 'song:2',
      result: 'failure',
      error: 'source-refused',
    });

    await jest.advanceTimersByTimeAsync(MIN_WAIT_MS);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(toolRuns()).toHaveLength(2);
    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ assetId: 'song:1' }),
        data: expect.objectContaining({ status: 'success' }),
      }),
    );
    expect(recorded).toEqual(['address', 'ok']);
    service.onModuleDestroy();
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

describe('dutyCycleWaitMs', () => {
  it('waits three times as long as the run, so the job is busy about a quarter of the time', () => {
    expect(DUTY_CYCLE_MULTIPLE).toBe(3);
    expect(dutyCycleWaitMs(4_000)).toBe(12_000);
    expect(dutyCycleWaitMs(60_000)).toBe(180_000);
  });

  it('never waits less than the minimum or more than the maximum', () => {
    expect(MIN_WAIT_MS).toBe(5_000);
    expect(MAX_WAIT_MS).toBe(10 * 60_000);
    expect(dutyCycleWaitMs(0)).toBe(MIN_WAIT_MS);
    expect(dutyCycleWaitMs(-50)).toBe(MIN_WAIT_MS);
    expect(dutyCycleWaitMs(1_000)).toBe(MIN_WAIT_MS);
    expect(dutyCycleWaitMs(200_000)).toBe(200_000 * 3);
    expect(dutyCycleWaitMs(400_000)).toBe(MAX_WAIT_MS);
  });
});

describe('MediaAnalysisService backlog', () => {
  it('publishes how many assets still wait, and zero when none do', async () => {
    const { service, metrics } = setup([
      [candidate({ remaining: BigInt(4321) })],
      [],
    ]);
    await service.runOnce(NOW);
    expect(metrics.setBacklog).toHaveBeenLastCalledWith(4321);
    await service.runOnce(NOW);
    expect(metrics.setBacklog).toHaveBeenLastCalledWith(0);
  });
});
