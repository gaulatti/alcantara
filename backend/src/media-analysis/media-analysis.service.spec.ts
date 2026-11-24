/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method, @typescript-eslint/require-await -- Jest mocks are intentionally loosely typed. */
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptedTransport } from '../outbound/safe-fetch.testing';
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
  MAX_WRITE_RETRIES,
  RETRY_BACKOFF_MS,
  MIN_WAIT_MS,
  IDLE_POLL_MS,
  LEASE_MS,
  MAX_ATTEMPTS,
  BACKFILL_RETRY_AFTER_MS,
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
  ruleVersion: 2,
  cueRule: { head: 'applied', tail: 'bounded' },
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
  ruleVersion: null,
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
  const metrics = {
    record: jest.fn(),
    setBacklog: jest.fn(),
    recordWrite: jest.fn(),
    recordCueRule: jest.fn(),
    setDurationBackfill: jest.fn(),
  };
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
    // Analysed assets without a stored length come after every pending or retryable asset.
    expect(query.sql).toContain(`m."status" = 'success'`);
    expect(query.sql).toContain('m."durationSeconds" IS NULL');
    expect(query.sql).toContain('WHERE "due" OR "needsDuration"');
    expect(query.sql).toContain('ORDER BY "due" DESC, "createdAt" DESC');
    expect(query.sql).toContain('LIMIT 1');
    expect(query.sql).toContain(
      'COUNT(*) FILTER (WHERE "due") OVER () AS "remaining"',
    );
    expect(query.sql).toContain(
      'COUNT(*) FILTER (WHERE NOT "due") OVER () AS "backfillRemaining"',
    );
    expect(query.values).toEqual([
      NOW.toISOString(),
      MAX_ATTEMPTS,
      new Date(NOW.getTime() - BACKFILL_RETRY_AFTER_MS).toISOString(),
    ]);
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
        durationSeconds: 240,
        isrc: 'USRC17607839',
        musicbrainzRecordingId: null,
        ruleVersion: 2,
        error: null,
        nextAttemptAt: null,
      },
    });
    expect(metrics.record).toHaveBeenCalledWith('success', expect.any(Number));
    expect(metrics.recordCueRule).toHaveBeenCalledWith({
      head: 'applied',
      tail: 'bounded',
    });
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
    const transport = scriptedTransport(
      {
        'inside.example.com': ['10.0.0.8'],
        'bucket.s3.amazonaws.com': ['52.216.8.1'],
      },
      {
        'bucket.s3.amazonaws.com/songs/a.mp3': {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
          body: Buffer.from('ID3 placeholder'),
        },
      },
    );
    const tempRoot = mkdtempSync(join(tmpdir(), 'analysis-service-spec-'));
    const analyzer = new FfmpegAudioAnalyzer(run, {
      resolve: transport.resolve,
      request: transport.request,
      record: (_path, result) => recorded.push(result),
      tempRoot,
    });
    // The fetched input is a real temporary file: let its disk I/O finish
    // between fake-timer steps.
    const { setTimeout: realTimeout } =
      jest.requireActual<typeof import('timers')>('timers');
    const settle = async (done: () => boolean) => {
      const started = process.hrtime.bigint();
      while (!done() && process.hrtime.bigint() - started < 10_000_000_000n) {
        await jest.advanceTimersByTimeAsync(0);
        await new Promise((resolve) => realTimeout(resolve, 1));
      }
    };
    const service = new MediaAnalysisService(
      prisma as never,
      metrics as never,
      analyzer,
    );

    await service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(START_DELAY_MS);
    await settle(
      () => prisma.mediaAssetAnalysis.updateMany.mock.calls.length > 0,
    );
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
    await settle(() => recorded.length === 2 && toolRuns().length === 2);
    await settle(() =>
      JSON.stringify(
        prisma.mediaAssetAnalysis.updateMany.mock.lastCall,
      ).includes('success'),
    );
    expect(toolRuns()).toHaveLength(2);
    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ assetId: 'song:1' }),
        data: expect.objectContaining({ status: 'success' }),
      }),
    );
    expect(recorded).toEqual(['address', 'ok']);
    expect(transport.sent.map((request) => request.connectedTo)).toEqual([
      '52.216.8.1',
    ]);
    service.onModuleDestroy();
    await settle(() => readdirSync(tempRoot).length === 0);
    expect(readdirSync(tempRoot)).toEqual([]);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('keeps polling after a run fails before analysing', async () => {
    jest.useFakeTimers();
    const { service, prisma } = setup();
    prisma.$queryRaw.mockRejectedValueOnce(new Error('database unavailable'));

    await service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(START_DELAY_MS);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Media analysis run failed before analysing a file (Error)',
    );
    await jest.advanceTimersByTimeAsync(IDLE_POLL_MS);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });

  describe('a transient database error at the start of a run (#276)', () => {
    const transient: Array<[string, () => Error, string]> = [
      [
        'a raw query that lost its connection (SQLSTATE 08006)',
        () =>
          new Prisma.PrismaClientKnownRequestError('connection failure', {
            code: 'P2010',
            clientVersion: 'test',
            meta: { code: '08006', message: 'terminating connection' },
          }),
        'PrismaClientKnownRequestError P2010 08006',
      ],
      [
        'a raw query cancelled by a timeout (SQLSTATE 57014)',
        () =>
          new Prisma.PrismaClientKnownRequestError('Operation has timed out', {
            code: 'P2010',
            clientVersion: 'test',
            meta: { code: '57014', message: 'canceling statement' },
          }),
        'PrismaClientKnownRequestError P2010 57014',
      ],
      [
        'a raw query on a server that is shutting down (SQLSTATE 57P01)',
        () =>
          new Prisma.PrismaClientKnownRequestError('admin shutdown', {
            code: 'P2010',
            clientVersion: 'test',
            meta: { code: '57P01' },
          }),
        'PrismaClientKnownRequestError P2010 57P01',
      ],
      [
        'a raw query refused for too many connections (SQLSTATE 53300)',
        () =>
          new Prisma.PrismaClientKnownRequestError('too many', {
            code: 'P2010',
            clientVersion: 'test',
            meta: { code: '53300' },
          }),
        'PrismaClientKnownRequestError P2010 53300',
      ],
      [
        'a pool timeout',
        () =>
          new Prisma.PrismaClientKnownRequestError('pool timeout', {
            code: 'P2024',
            clientVersion: 'test',
          }),
        'PrismaClientKnownRequestError P2024',
      ],
      [
        'a database that cannot be reached',
        () => new Prisma.PrismaClientInitializationError('unreachable', 'test'),
        'PrismaClientInitializationError',
      ],
      [
        'an unknown request error',
        () =>
          new Prisma.PrismaClientUnknownRequestError('connection reset', {
            clientVersion: 'test',
          }),
        'PrismaClientUnknownRequestError',
      ],
    ];

    it.each(transient)(
      'warns with the cause class for %s, never errors, and the next run analyses the file',
      async (_name, make, cause) => {
        jest.useFakeTimers();
        const { service, prisma, analyzer } = setup([[candidate()]]);
        prisma.$queryRaw.mockRejectedValueOnce(make());

        await service.onApplicationBootstrap();
        await jest.advanceTimersByTimeAsync(START_DELAY_MS);
        expect(Logger.prototype.warn).toHaveBeenCalledWith(
          `Media analysis run failed before analysing a file (${cause}); the next run retries it`,
        );
        expect(Logger.prototype.error).not.toHaveBeenCalled();
        expect(analyzer.analyze).not.toHaveBeenCalled();
        expect(prisma.mediaAssetAnalysis.create).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(IDLE_POLL_MS);
        expect(analyzer.analyze).toHaveBeenCalledWith(
          URL_A,
          ANALYSIS_TIMEOUT_MS,
        );
        expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenLastCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: 'success' }),
          }),
        );
        service.onModuleDestroy();
      },
    );

    it.each([
      ['a wrong query (SQLSTATE 42703)', { code: '42703' }, 'P2010 42703'],
      ['a raw query with no database code', undefined, 'P2010'],
      [
        'a raw query with a code that is not a SQLSTATE',
        { code: 'oops' },
        'P2010',
      ],
    ])(
      'keeps ERROR for %s: it must not be retried forever as a warning',
      async (_name, meta, cause) => {
        jest.useFakeTimers();
        const { service, prisma } = setup();
        prisma.$queryRaw.mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('column does not exist', {
            code: 'P2010',
            clientVersion: 'test',
            meta,
          }),
        );

        await service.onApplicationBootstrap();
        await jest.advanceTimersByTimeAsync(START_DELAY_MS);
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          `Media analysis run failed before analysing a file (PrismaClientKnownRequestError ${cause})`,
        );
        expect(Logger.prototype.warn).not.toHaveBeenCalled();
        service.onModuleDestroy();
      },
    );

    it('keeps ERROR for a failure that is not transient, with its class and never its message', async () => {
      jest.useFakeTimers();
      const { service, prisma } = setup();
      prisma.$queryRaw.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError(
          'The table MediaAsset does not exist',
          { code: 'P2021', clientVersion: 'test' },
        ),
      );

      await service.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(START_DELAY_MS);
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        'Media analysis run failed before analysing a file (PrismaClientKnownRequestError P2021)',
      );
      expect(Logger.prototype.warn).not.toHaveBeenCalled();
      service.onModuleDestroy();
    });

    it('names an error with no name as Error', async () => {
      jest.useFakeTimers();
      const { service, prisma } = setup();
      const nameless = new Error('boom');
      nameless.name = '';
      prisma.$queryRaw.mockRejectedValueOnce(nameless);

      await service.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(START_DELAY_MS);
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        'Media analysis run failed before analysing a file (Error)',
      );
      service.onModuleDestroy();
    });

    it('names a thrown value that is not an Error by its type', async () => {
      jest.useFakeTimers();
      const { service, prisma } = setup();
      prisma.$queryRaw.mockRejectedValueOnce('boom');

      await service.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(START_DELAY_MS);
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        'Media analysis run failed before analysing a file (string)',
      );
      service.onModuleDestroy();
    });
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

describe('storing the decoded length (#296)', () => {
  const backfillRow = (overrides: Record<string, unknown> = {}) =>
    candidate({
      analysisUpdatedAt: ROW_UPDATED_AT,
      attempts: 1,
      backfill: true,
      backfillRemaining: BigInt(4),
      remaining: BigInt(0),
      ...overrides,
    });

  it('stores the length of a file with every successful result', async () => {
    const { service, prisma } = setup();
    await service.runOnce(NOW);
    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenLastCalledWith({
      where: { assetId: 'song:1', sourceUrl: URL_A, status: 'pending' },
      data: expect.objectContaining({
        status: 'success',
        durationSeconds: 240,
        cueInSeconds: 1.5,
      }),
    });
  });

  it('stores no length that is not a positive number', async () => {
    const { service, prisma, analyzer } = setup();
    analyzer.analyze.mockResolvedValueOnce({
      ...ANALYSIS,
      durationSeconds: Number.NaN,
    });
    await service.runOnce(NOW);
    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'success',
          durationSeconds: null,
        }),
      }),
    );
  });

  it('measures an analysed asset again only to store its length, keeping the row a success', async () => {
    const { service, prisma, analyzer, metrics } = setup([[backfillRow()]]);

    await expect(service.runOnce(NOW)).resolves.toBe(true);

    expect(prisma.mediaAssetAnalysis.create).not.toHaveBeenCalled();
    expect(prisma.mediaAssetAnalysis.updateMany.mock.calls).toEqual([
      [
        {
          where: {
            assetId: 'song:1',
            updatedAt: ROW_UPDATED_AT,
            status: 'success',
            durationSeconds: null,
          },
          data: { attempts: 2 },
        },
      ],
      [
        {
          where: {
            assetId: 'song:1',
            sourceUrl: URL_A,
            status: 'success',
            durationSeconds: null,
          },
          data: { durationSeconds: 240 },
        },
      ],
    ]);
    // Nothing else of the measurement is written, and the run counts as a success.
    expect(analyzer.analyze).toHaveBeenCalledWith(URL_A, ANALYSIS_TIMEOUT_MS);
    expect(metrics.record).toHaveBeenCalledWith('success', expect.any(Number));
    expect(metrics.setDurationBackfill).toHaveBeenCalledWith(4);
    expect(metrics.setBacklog).toHaveBeenCalledWith(0);
  });

  it('leaves the measurement alone when the length cannot be measured, and counts the attempt', async () => {
    const { service, prisma, analyzer, metrics } = setup([[backfillRow()]]);
    analyzer.analyze.mockRejectedValueOnce(new AudioAnalysisError('timeout'));

    await expect(service.runOnce(NOW)).resolves.toBe(true);

    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { attempts: 2 } }),
    );
    expect(metrics.record).toHaveBeenCalledWith('retry', expect.any(Number));
    expect(Logger.prototype.warn).toHaveBeenCalledWith({
      event: 'media_analysis.failed',
      assetId: 'song:1',
      result: 'retry',
      error: 'timeout',
    });
  });

  it('records an unexpected analyzer error as decode-failed and counts the attempt', async () => {
    const { service, prisma, analyzer } = setup([[backfillRow()]]);
    analyzer.analyze.mockRejectedValueOnce(new Error('unexpected'));

    await expect(service.runOnce(NOW)).resolves.toBe(true);

    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { attempts: 2 } }),
    );
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'media_analysis.failed',
        assetId: 'song:1',
        error: 'decode-failed',
      }),
    );
  });

  it('does not run a tool for a source that is not a URL, and does not wipe the row', async () => {
    const { service, prisma, analyzer } = setup([
      [backfillRow({ sourceUrl: 'file:///etc/passwd' })],
    ]);
    await service.runOnce(NOW);
    expect(analyzer.analyze).not.toHaveBeenCalled();
    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenCalledTimes(1);
  });

  it('skips an asset another instance took first, and stores nothing for a length that is not usable', async () => {
    const taken = setup([[backfillRow()]]);
    taken.prisma.mediaAssetAnalysis.updateMany.mockResolvedValueOnce({
      count: 0,
    });
    await taken.service.runOnce(NOW);
    expect(taken.analyzer.analyze).not.toHaveBeenCalled();

    const unusable = setup([[backfillRow({ attempts: null })]]);
    unusable.analyzer.analyze.mockResolvedValueOnce({
      ...ANALYSIS,
      durationSeconds: 0,
    });
    await unusable.service.runOnce(NOW);
    expect(unusable.prisma.mediaAssetAnalysis.updateMany).toHaveBeenCalledTimes(
      1,
    );
    expect(unusable.prisma.mediaAssetAnalysis.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { attempts: 1 } }),
    );
  });

  it('reports no backfill when nothing is waiting', async () => {
    const { service, metrics } = setup([[]]);
    await service.runOnce(NOW);
    expect(metrics.setDurationBackfill).toHaveBeenCalledWith(0);
  });
});

describe('a database error on the result write (#278)', () => {
  const transientError = () =>
    new Prisma.PrismaClientKnownRequestError('connection failure', {
      code: 'P2010',
      clientVersion: 'test',
      meta: { code: '08006', message: 'terminating connection' },
    });
  const CAUSE = 'PrismaClientKnownRequestError P2010 08006';

  // The write of a result is the update that matches the row by asset, source and 'pending';
  // the claim and the release are other updates.
  const isResultWrite = (args: { data: { status?: string } }) =>
    args.data.status === 'success' || args.data.status === 'failed';

  function failResultWrites(
    prisma: ReturnType<typeof setup>['prisma'],
    error: () => Error,
    times: number,
  ) {
    let failures = 0;
    prisma.mediaAssetAnalysis.updateMany.mockImplementation((async (
      args: never,
    ) => {
      if (isResultWrite(args) && failures < times) {
        failures += 1;
        throw error();
      }
      return { count: 1 };
    }) as never);
  }
  const resultWrites = (prisma: ReturnType<typeof setup>['prisma']) =>
    prisma.mediaAssetAnalysis.updateMany.mock.calls.filter((call) =>
      isResultWrite((call as unknown[])[0] as never),
    );

  it('keeps the finished measurement and stores it on the next run, without a second analysis or attempt', async () => {
    const { service, prisma, analyzer, metrics } = setup([[candidate()]]);
    failResultWrites(prisma, transientError, 1);

    await expect(service.runOnce(NOW)).resolves.toBe(true);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      `Media analysis could not store a finished result (${CAUSE}); retrying on the next run (1 of ${MAX_WRITE_RETRIES})`,
    );
    expect(Logger.prototype.error).not.toHaveBeenCalled();
    expect(metrics.record).not.toHaveBeenCalled();
    expect(metrics.recordWrite).toHaveBeenCalledWith('retried');

    // The next run stores the held result before it takes another candidate.
    await expect(service.runOnce(NOW)).resolves.toBe(true);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
    expect(prisma.mediaAssetAnalysis.create).toHaveBeenCalledTimes(1);
    expect(prisma.mediaAssetAnalysis.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ attempts: 1 }),
    });
    const writes = resultWrites(prisma);
    expect(writes).toHaveLength(2);
    expect((writes[1] as unknown[])[0]).toEqual(
      expect.objectContaining({
        where: { assetId: 'song:1', sourceUrl: URL_A, status: 'pending' },
        data: expect.objectContaining({
          status: 'success',
          cueInSeconds: 1.5,
          integratedLufs: -14.2,
        }),
      }),
    );
    expect(metrics.record).toHaveBeenCalledTimes(1);
    expect(metrics.record).toHaveBeenCalledWith('success', expect.any(Number));
    expect(metrics.recordWrite).toHaveBeenLastCalledWith('stored_after_retry');

    // Nothing is held any more: the next run takes the next candidate.
    await expect(service.runOnce(NOW)).resolves.toBe(false);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('takes no other candidate while a result waits, so the retries are bounded and nothing is analysed twice', async () => {
    const { service, prisma, analyzer } = setup([
      [candidate()],
      [candidate({ assetId: 'song:2' })],
    ]);
    failResultWrites(prisma, transientError, 99);

    // The failed write and each of its retries.
    for (let run = 0; run <= MAX_WRITE_RETRIES; run += 1) {
      await expect(service.runOnce(NOW)).resolves.toBe(true);
    }
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
    expect(resultWrites(prisma)).toHaveLength(1 + MAX_WRITE_RETRIES);

    // Retries exhausted: the next run moves on to another asset.
    await service.runOnce(NOW);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(analyzer.analyze).toHaveBeenLastCalledWith(
      URL_A,
      ANALYSIS_TIMEOUT_MS,
    );
  });

  it('releases the claim with the attempt it had when the retries run out, and warns with the cause class', async () => {
    const { service, prisma, metrics } = setup([
      [
        candidate({
          analysisUpdatedAt: ROW_UPDATED_AT,
          attempts: 1,
        }),
      ],
    ]);
    failResultWrites(prisma, transientError, 99);

    for (let run = 0; run <= MAX_WRITE_RETRIES; run += 1) {
      await service.runOnce(NOW);
    }

    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenLastCalledWith({
      where: { assetId: 'song:1', sourceUrl: URL_A, status: 'pending' },
      data: {
        attempts: 1,
        nextAttemptAt: new Date(NOW.getTime() + RETRY_BACKOFF_MS[0]),
      },
    });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      `Media analysis gave up storing a finished result (${CAUSE}) after ${MAX_WRITE_RETRIES} retries; the file is analysed again without spending an attempt`,
    );
    expect(Logger.prototype.error).not.toHaveBeenCalled();
    expect(metrics.recordWrite).toHaveBeenLastCalledWith('released');
    expect(metrics.record).not.toHaveBeenCalled();
  });

  it('does not end a file as interrupted when the write fails at the third attempt', async () => {
    const { service, prisma } = setup([
      [candidate({ analysisUpdatedAt: ROW_UPDATED_AT, attempts: 2 })],
    ]);
    failResultWrites(prisma, transientError, 99);

    for (let run = 0; run <= MAX_WRITE_RETRIES; run += 1) {
      await service.runOnce(NOW);
    }

    const writtenData = prisma.mediaAssetAnalysis.updateMany.mock.calls.map(
      (call) =>
        ((call as unknown[])[0] as { data: Record<string, unknown> }).data,
    );
    expect(writtenData.some((data) => data.error === 'interrupted')).toBe(
      false,
    );
    // The row is released with the two attempts it had before this run, not three.
    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          attempts: 2,
          nextAttemptAt: new Date(NOW.getTime() + RETRY_BACKOFF_MS[0]),
        },
      }),
    );
  });

  it('stores a failed analysis that the database dropped, without running the tool again', async () => {
    const { service, prisma, analyzer, metrics } = setup([[candidate()]]);
    analyzer.analyze.mockRejectedValueOnce(
      new AudioAnalysisError('decode-failed'),
    );
    failResultWrites(prisma, transientError, 1);

    await service.runOnce(NOW);
    expect(metrics.record).not.toHaveBeenCalled();
    await service.runOnce(NOW);

    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
    expect(prisma.mediaAssetAnalysis.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          error: 'decode-failed',
          nextAttemptAt: new Date(NOW.getTime() + RETRY_BACKOFF_MS[0]),
        }),
      }),
    );
    expect(metrics.record).toHaveBeenCalledWith('retry', expect.any(Number));
  });

  it('logs an error with the cause class for a write that cannot succeed, and does not retry it', async () => {
    const { service, prisma, analyzer, metrics } = setup([
      [candidate()],
      [candidate({ assetId: 'song:2' })],
    ]);
    failResultWrites(
      prisma,
      () =>
        new Prisma.PrismaClientKnownRequestError('constraint', {
          code: 'P2003',
          clientVersion: 'test',
        }),
      99,
    );

    await expect(service.runOnce(NOW)).resolves.toBe(true);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Media analysis could not store the result of a file (PrismaClientKnownRequestError P2003)',
    );
    expect(Logger.prototype.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('retrying on the next run'),
    );
    expect(metrics.recordWrite).toHaveBeenCalledWith('dropped');

    // The next run takes the next candidate: nothing is held and nothing loops.
    await service.runOnce(NOW);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(analyzer.analyze).toHaveBeenCalledTimes(2);
    expect(resultWrites(prisma)).toHaveLength(2);
  });

  it('lets the lease run out when even the release cannot be written', async () => {
    const { service, prisma } = setup([
      [candidate({ analysisUpdatedAt: ROW_UPDATED_AT, attempts: 0 })],
    ]);
    prisma.mediaAssetAnalysis.updateMany.mockImplementation((async (
      args: never,
    ) => {
      if ((args as { data: { status?: string } }).data.status === 'pending') {
        return { count: 1 };
      }
      throw transientError();
    }) as never);

    for (let run = 0; run <= MAX_WRITE_RETRIES; run += 1) {
      await expect(service.runOnce(NOW)).resolves.toBe(true);
    }

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      `Media analysis could not release the claim of a finished result (${CAUSE}); the lease runs out and the file is analysed again`,
    );
    expect(Logger.prototype.error).not.toHaveBeenCalled();
    await expect(service.runOnce(NOW)).resolves.toBe(false);
  });

  it('keeps the schedule going: a held write waits for the duty cycle like any run', async () => {
    jest.useFakeTimers();
    const { service, prisma, analyzer } = setup([[candidate()]]);
    failResultWrites(prisma, transientError, 1);

    await service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(START_DELAY_MS);
    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
    expect(resultWrites(prisma)).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(MIN_WAIT_MS);
    expect(resultWrites(prisma)).toHaveLength(2);
    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
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
