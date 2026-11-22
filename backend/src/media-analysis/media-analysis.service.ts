import { isDeployCandidate } from '../config/deploy-candidate';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  AudioAnalysisError,
  FfmpegAudioAnalyzer,
  type AudioAnalysis,
} from './ffmpeg-audio.analyzer';
import {
  MediaAnalysisMetrics,
  type MediaAnalysisResult,
} from './media-analysis.metrics';

export const MEDIA_AUDIO_ANALYZER = Symbol('MEDIA_AUDIO_ANALYZER');

/** Waits this long after startup before the first run, so a deploy's own startup never competes with it. */
export const START_DELAY_MS = 5 * 60_000;
/**
 * Duty cycle while there is work: after each run the job waits this many
 * times as long as the run took, so it is busy at most 1 part in 4 (about a
 * quarter of one core). The wait is bounded below and above.
 */
export const DUTY_CYCLE_MULTIPLE = 3;
export const MIN_WAIT_MS = 5_000;
export const MAX_WAIT_MS = 10 * 60_000;
/** Wait when no asset needs analysis. */
export const IDLE_POLL_MS = 60_000;
/** Deadline for one file, covering the probe and the measurement. */
export const ANALYSIS_TIMEOUT_MS = 180_000;
/** A claimed run that has not finished by then is treated as interrupted. */
export const LEASE_MS = 10 * 60_000;
/** Runs per source before a failure is final. */
export const MAX_ATTEMPTS = 3;
/** Wait before the second and the third run. */
export const RETRY_BACKOFF_MS = [5 * 60_000, 30 * 60_000];
const TOOL_CHECK_TIMEOUT_MS = 10_000;

type FailureCode =
  | AudioAnalysisError['code']
  | 'unsupported-source'
  | 'interrupted';

interface Candidate {
  assetId: string;
  sourceUrl: string;
  analysisUpdatedAt: Date | null;
  attempts: number | null;
  sourceChanged: boolean;
  remaining: bigint | number;
}

/** The wait after a run that took `elapsedMs`, whatever its outcome. */
export function dutyCycleWaitMs(elapsedMs: number): number {
  const wait = Math.max(0, elapsedMs) * DUTY_CYCLE_MULTIPLE;
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, wait));
}

const EMPTY_MEASUREMENT = {
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

/** Prisma codes of a database that is slow or unreachable, not of a query or schema that is wrong. */
const TRANSIENT_PRISMA_CODES = new Set([
  'P1001', // cannot reach the server
  'P1002', // the server timed out
  'P1008', // the operation timed out
  'P1017', // the server closed the connection
  'P2024', // no connection available from the pool in time
  'P2034', // a transaction conflict or deadlock
]);

/**
 * A raw query that failed (P2010) is transient only when the database itself
 * says so: a connection exception (SQLSTATE class 08), the server shutting
 * down or not accepting connections (57P01-57P03), too many connections
 * (53300) or a cancelled/timed out statement (57014). A wrong query (42xxx) or
 * anything the database does not code stays an error.
 */
const TRANSIENT_SQLSTATE = /^(08[0-9A-Z]{3}|57P0[123]|53300|57014)$/;

/** The SQLSTATE the database gave a failed raw query, when it is a 5-character code. */
function rawQuerySqlState(
  error: Prisma.PrismaClientKnownRequestError,
): string | null {
  const code = (error.meta as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/** The class of a caught value, with a Prisma error's code: safe to log, never the message. */
function errorCause(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const sqlState = error.code === 'P2010' ? rawQuerySqlState(error) : null;
    return `${error.name} ${error.code}${sqlState ? ` ${sqlState}` : ''}`;
  }
  if (error instanceof Error) return error.name || 'Error';
  return typeof error;
}

function isTransientDatabaseError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2010') {
      const sqlState = rawQuerySqlState(error);
      return sqlState !== null && TRANSIENT_SQLSTATE.test(sqlState);
    }
    return TRANSIENT_PRISMA_CODES.has(error.code);
  }
  return (
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientUnknownRequestError
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Measures every audio asset once per source URL, one file at a time, and
 * stores the result in MediaAssetAnalysis. It never touches uploads or the
 * asset itself: a failure only marks the analysis row failed.
 */
@Injectable()
export class MediaAnalysisService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MediaAnalysisService.name);
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MediaAnalysisMetrics,
    @Inject(MEDIA_AUDIO_ANALYZER)
    private readonly analyzer: FfmpegAudioAnalyzer,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (isDeployCandidate()) {
      this.logger.log('Deploy candidate: media analysis is not scheduled');
      return;
    }
    if (!(await this.analyzer.available(TOOL_CHECK_TIMEOUT_MS))) {
      this.logger.error(
        'Media analysis is not scheduled: ffmpeg or ffprobe is not installed',
      );
      return;
    }
    this.logger.log(
      this.analyzer.lowPriority
        ? 'Media analysis is scheduled at lowered priority'
        : 'Media analysis is scheduled; nice is not installed, so it runs at normal priority',
    );
    this.schedule(START_DELAY_MS);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref();
  }

  // Any run that handled an asset, failed or not, is followed by the duty-cycle wait.
  private async tick(): Promise<void> {
    const startedAt = Date.now();
    let worked = false;
    try {
      worked = await this.runOnce();
    } catch (error) {
      this.logRunFailure(error);
    }
    this.schedule(
      worked ? dutyCycleWaitMs(Date.now() - startedAt) : IDLE_POLL_MS,
    );
  }

  // A run that failed on a transient database error (a timeout, a dropped
  // connection) changed nothing a later run depends on: the asset is still
  // unanalysed or its lease runs out, and the next cycle takes it up again.
  // That is a warning with the cause class (#276); any other failure stays an
  // error. Never the message, which can carry a query or a host.
  private logRunFailure(error: unknown): void {
    const cause = errorCause(error);
    if (isTransientDatabaseError(error)) {
      this.logger.warn(
        `Media analysis run failed before analysing a file (${cause}); the next run retries it`,
      );
      return;
    }
    this.logger.error(
      `Media analysis run failed before analysing a file (${cause})`,
    );
  }

  /** Analyses at most one asset. Returns whether an asset was handled. */
  async runOnce(now = new Date()): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const candidate = await this.nextCandidate(now);
      this.metrics.setBacklog(candidate ? Number(candidate.remaining) : 0);
      if (!candidate) return false;
      await this.handle(candidate, now);
      return true;
    } finally {
      this.running = false;
    }
  }

  // The newest audio asset that has no analysis, whose analysis describes another
  // source URL, or whose retry or lease time has come, with how many such assets remain.
  private async nextCandidate(now: Date): Promise<Candidate | null> {
    const rows = await this.prisma.$queryRaw<Candidate[]>(Prisma.sql`
      SELECT a."id" AS "assetId",
             a."sourceUrl" AS "sourceUrl",
             m."updatedAt" AS "analysisUpdatedAt",
             m."attempts" AS "attempts",
             (m."assetId" IS NOT NULL AND m."sourceUrl" IS DISTINCT FROM a."sourceUrl") AS "sourceChanged",
             COUNT(*) OVER () AS "remaining"
      FROM "MediaAsset" a
      LEFT JOIN "MediaAssetAnalysis" m ON m."assetId" = a."id"
      WHERE a."mediaType" = 'AUDIO'
        AND (
          m."assetId" IS NULL
          OR m."sourceUrl" IS DISTINCT FROM a."sourceUrl"
          OR m."nextAttemptAt" <= CAST(${now.toISOString()} AS TIMESTAMP(3))
        )
      ORDER BY a."createdAt" DESC, a."id" ASC
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  private async handle(candidate: Candidate, now: Date): Promise<void> {
    const startedAt = Date.now();
    const previousAttempts = candidate.sourceChanged
      ? 0
      : (candidate.attempts ?? 0);

    if (previousAttempts >= MAX_ATTEMPTS) {
      // The last run was claimed and never finished, so the failure is final.
      if (await this.settle(candidate, this.failure('interrupted', now))) {
        this.finish(candidate, 'failure', startedAt, 'interrupted');
      }
      return;
    }

    const attempts = previousAttempts + 1;
    if (!(await this.claim(candidate, attempts, now))) return;

    if (!isHttpUrl(candidate.sourceUrl)) {
      await this.write(candidate, this.failure('unsupported-source', now));
      this.finish(candidate, 'failure', startedAt, 'unsupported-source');
      return;
    }

    let analysis: AudioAnalysis;
    try {
      analysis = await this.analyzer.analyze(
        candidate.sourceUrl,
        ANALYSIS_TIMEOUT_MS,
      );
    } catch (error) {
      const failure =
        error instanceof AudioAnalysisError
          ? error
          : new AudioAnalysisError('decode-failed');
      const backoff = failure.retryable
        ? RETRY_BACKOFF_MS[attempts - 1]
        : undefined;
      const data = this.failure(failure.code, now, backoff);
      await this.write(candidate, data);
      this.finish(
        candidate,
        data.nextAttemptAt ? 'retry' : 'failure',
        startedAt,
        failure.code,
      );
      return;
    }

    await this.write(candidate, {
      status: 'success',
      cueInSeconds: analysis.cueInSeconds,
      cueOutSeconds: analysis.cueOutSeconds,
      fadeInSeconds: null,
      fadeOutSeconds: null,
      overlapSeconds: null,
      integratedLufs: analysis.integratedLufs,
      truePeakDbtp: analysis.truePeakDbtp,
      isrc: analysis.isrc,
      musicbrainzRecordingId: analysis.musicbrainzRecordingId,
      error: null,
      nextAttemptAt: null,
    });
    this.finish(candidate, 'success', startedAt);
  }

  // A failed row keeps no measurement. It is retried after the backoff when one
  // is given: never after the last run or a failure that cannot change.
  private failure(
    code: FailureCode,
    now: Date,
    backoff?: number,
  ): Prisma.MediaAssetAnalysisUpdateManyMutationInput {
    return {
      status: 'failed',
      ...EMPTY_MEASUREMENT,
      error: code,
      nextAttemptAt:
        backoff === undefined ? null : new Date(now.getTime() + backoff),
    };
  }

  // Claims the asset for this run. A row is claimed only if no one changed it
  // since it was read, so two backend instances never analyse the same file.
  private async claim(
    candidate: Candidate,
    attempts: number,
    now: Date,
  ): Promise<boolean> {
    const lease = {
      status: 'pending',
      attempts,
      nextAttemptAt: new Date(now.getTime() + LEASE_MS),
      sourceUrl: candidate.sourceUrl,
    };
    try {
      if (!candidate.analysisUpdatedAt) {
        await this.prisma.mediaAssetAnalysis.create({
          data: { assetId: candidate.assetId, ...lease },
        });
        return true;
      }
      return await this.settle(candidate, lease);
    } catch {
      // Another instance created the row first, or the asset was deleted.
      return false;
    }
  }

  private async settle(
    candidate: Candidate,
    data: Prisma.MediaAssetAnalysisUpdateManyMutationInput,
  ): Promise<boolean> {
    const { count } = await this.prisma.mediaAssetAnalysis.updateMany({
      where: {
        assetId: candidate.assetId,
        updatedAt: candidate.analysisUpdatedAt!,
      },
      data: { ...data, sourceUrl: candidate.sourceUrl },
    });
    return count === 1;
  }

  // Writes the result of a claimed run. The row is matched by asset and source
  // so a result never lands on a row that now describes another file.
  private async write(
    candidate: Candidate,
    data: Prisma.MediaAssetAnalysisUpdateManyMutationInput,
  ): Promise<void> {
    await this.prisma.mediaAssetAnalysis.updateMany({
      where: {
        assetId: candidate.assetId,
        sourceUrl: candidate.sourceUrl,
        status: 'pending',
      },
      data,
    });
  }

  private finish(
    candidate: Candidate,
    result: MediaAnalysisResult,
    startedAt: number,
    error?: FailureCode,
  ): void {
    this.metrics.record(result, (Date.now() - startedAt) / 1000);
    if (result === 'success') return;
    this.logger.warn({
      event: 'media_analysis.failed',
      assetId: candidate.assetId,
      result,
      error,
    });
  }
}
