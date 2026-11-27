import {
  PlayoutLease,
  startWhenActive,
} from '../playout/playout-lease.service';
import { isDeployCandidate } from '../config/deploy-candidate';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  AudioAnalysisError,
  BOUND_KEEPS_RULE_VERSION,
  CUE_RULE_VERSION,
  FfmpegAudioAnalyzer,
  PREVIOUS_CUE_RULE_VERSION,
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
/** The first run when a stopped process left work behind: sooner, since that work was already running. */
export const RESUME_DELAY_MS = 60_000;
/**
 * Interrupted runs of one source that cost no attempt. After these an interruption counts, so a file that takes the
 * process down with it cannot be retried for ever.
 */
export const MAX_HAND_BACKS = 3;
/** A claimed run that has not finished by then is treated as interrupted. */
export const LEASE_MS = 10 * 60_000;
/** Runs per source before a failure is final. */
export const MAX_ATTEMPTS = 3;
/** Wait before the second and the third run. */
export const RETRY_BACKOFF_MS = [5 * 60_000, 30 * 60_000];
/**
 * Runs that retry the write of a finished result, after the run that failed to
 * store it, before the claim is released (#278).
 */
export const MAX_WRITE_RETRIES = 3;
/**
 * A success row that has no stored length is measured again (#296) only if it has not been
 * touched for this long, so a run that failed is not repeated at once.
 */
export const BACKFILL_RETRY_AFTER_MS = RETRY_BACKOFF_MS[1];
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
  /** The stored row's status; null when there is no row. */
  status?: string | null;
  /** The cue rule a re-analysis request asked for (1 = the rule before #235, 2 = rule C); null means the current rule. */
  requestedRuleVersion?: number | null;
  /** True when the asset is analysed and only lacks a stored length (#296). */
  backfill?: boolean;
  /** Assets that need a first, a repeated or a retried analysis. */
  remaining: bigint | number;
  /** Analysed assets still without a stored length that can be measured now. */
  backfillRemaining?: bigint | number;
}

/**
 * Whether this run measures again a file that already has a good result for it. Such a run never takes that result
 * away: the row stays a success with its cues and loudness while the run is claimed and when it fails (#235).
 */
export function keepsResult(candidate: Candidate): boolean {
  return candidate.status === 'success' && !candidate.sourceChanged;
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
  ruleVersion: null,
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

/** A finished result the database refused, held until a later run stores it. */
interface HeldResult {
  candidate: Candidate;
  /** The attempts the asset had before the run that produced this result. */
  previousAttempts: number;
  data: Prisma.MediaAssetAnalysisUpdateManyMutationInput;
  outcome: MediaAnalysisResult;
  error?: FailureCode;
  /** How long the analysis itself took, for the duration metric. */
  analysisMs: number;
  retries: number;
}

/** The decoded length, when it is a usable one. */
function storedDuration(analysis: AudioAnalysis): number | null {
  const seconds = analysis.durationSeconds;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
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
  // The result of a finished analysis whose write failed on a transient database
  // error. It is lost on a restart; the lease then runs out as before (#278).
  private held: HeldResult | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MediaAnalysisMetrics,
    @Inject(MEDIA_AUDIO_ANALYZER)
    private readonly analyzer: FfmpegAudioAnalyzer,
    @Optional() private readonly lease?: PlayoutLease,
  ) {}

  private starting: Promise<void> = Promise.resolve();

  /**
   * Checks the tools and schedules the queue without holding start-up: the port does not open until every start-up
   * hook returns (alcantara#873).
   */
  onApplicationBootstrap(): void {
    if (isDeployCandidate()) {
      this.logger.log('Deploy candidate: media analysis is not scheduled');
      return;
    }
    // Only the instance holding the playout lease (alcantara#873) analyses. Not returned, so neither start-up nor an
    // activation waits for it.
    void startWhenActive(this.lease, () => {
      this.starting = this.startAnalysis().catch((error) =>
        this.logger.error(
          `Media analysis is not scheduled: it could not start (${errorCause(error)})`,
        ),
      );
    });
  }

  /** Resolves when the queue is scheduled, or was found not to be. */
  whenStarted(): Promise<void> {
    return this.starting;
  }

  private async startAnalysis(): Promise<void> {
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
    const handedBack = await this.handBackClaims();
    this.schedule(handedBack > 0 ? RESUME_DELAY_MS : START_DELAY_MS);
  }

  /**
   * Hands back the claims a stopped process left, so a restart does not leave them waiting out their lease
   * (gaulatti/alcantara#587). One backend analyses at a time: a deploy stops the old container before the new one
   * starts, and a deploy candidate schedules nothing. Returns how many rows were handed back; a database error is
   * logged and the lease then runs out as before.
   */
  async handBackClaims(now = new Date()): Promise<number> {
    const claimed = { claimedAt: { not: null } };
    try {
      const refunded = await this.prisma.mediaAssetAnalysis.updateMany({
        where: {
          ...claimed,
          attempts: { gt: 0 },
          interruptions: { lt: MAX_HAND_BACKS },
        },
        data: {
          claimedAt: null,
          nextAttemptAt: now,
          attempts: { decrement: 1 },
          interruptions: { increment: 1 },
        },
      });
      // What is still claimed has used its free interruptions: due now, with the attempt spent.
      const spent = await this.prisma.mediaAssetAnalysis.updateMany({
        where: claimed,
        data: { claimedAt: null, nextAttemptAt: now },
      });
      this.metrics.recordInterrupted('handed_back', refunded.count);
      this.metrics.recordInterrupted('attempt_spent', spent.count);
      return refunded.count + spent.count;
    } catch (error) {
      this.logger.warn(
        `Media analysis could not hand back interrupted runs (${errorCause(error)}); their lease runs out`,
      );
      return 0;
    }
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
      // A finished result that could not be stored comes first, so it is not
      // measured again and no other asset starves behind a retry that is bounded.
      if (this.held) {
        await this.retryHeld(this.held, now);
        return true;
      }
      const candidate = await this.nextCandidate(now);
      this.metrics.setBacklog(candidate ? Number(candidate.remaining) : 0);
      this.metrics.setDurationBackfill(
        candidate ? Number(candidate.backfillRemaining ?? 0) : 0,
      );
      if (!candidate) return false;
      await this.handle(candidate, now);
      return true;
    } finally {
      this.running = false;
    }
  }

  // The newest audio asset that has no analysis, whose analysis describes another
  // source URL, or whose retry or lease time has come, with how many such assets remain.
  // After all of those come the assets that were analysed but have no stored length
  // (#296), newest first, which are measured again one at a time at the same duty cycle:
  // new uploads and retries always go first, and nothing is updated in bulk. A row that
  // was touched in the last BACKFILL_RETRY_AFTER_MS, or that has used its attempts, is left alone.
  private async nextCandidate(now: Date): Promise<Candidate | null> {
    const backfillBefore = new Date(now.getTime() - BACKFILL_RETRY_AFTER_MS);
    const rows = await this.prisma.$queryRaw<Candidate[]>(Prisma.sql`
      WITH audio AS (
        SELECT a."id" AS "assetId",
               a."sourceUrl" AS "sourceUrl",
               a."createdAt" AS "createdAt",
               m."updatedAt" AS "analysisUpdatedAt",
               m."attempts" AS "attempts",
               m."status" AS "status",
               m."requestedRuleVersion" AS "requestedRuleVersion",
               (m."assetId" IS NOT NULL AND m."sourceUrl" IS DISTINCT FROM a."sourceUrl") AS "sourceChanged",
               COALESCE(
                 m."assetId" IS NULL
                 OR m."sourceUrl" IS DISTINCT FROM a."sourceUrl"
                 OR m."nextAttemptAt" <= CAST(${now.toISOString()} AS TIMESTAMP(3)),
                 FALSE
               ) AS "due",
               COALESCE(
                 m."status" = 'success'
                 AND m."durationSeconds" IS NULL
                 AND m."nextAttemptAt" IS NULL
                 AND m."attempts" < ${MAX_ATTEMPTS}
                 AND m."updatedAt" <= CAST(${backfillBefore.toISOString()} AS TIMESTAMP(3)),
                 FALSE
               ) AS "needsDuration"
        FROM "MediaAsset" a
        LEFT JOIN "MediaAssetAnalysis" m ON m."assetId" = a."id"
        WHERE a."mediaType" = 'AUDIO'
      )
      SELECT "assetId", "sourceUrl", "analysisUpdatedAt", "attempts", "sourceChanged", "requestedRuleVersion", "status", "status",
             NOT "due" AS "backfill",
             COUNT(*) FILTER (WHERE "due") OVER () AS "remaining",
             COUNT(*) FILTER (WHERE NOT "due") OVER () AS "backfillRemaining"
      FROM audio
      WHERE "due" OR "needsDuration"
      ORDER BY "due" DESC, "createdAt" DESC, "assetId" ASC
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  private async handle(candidate: Candidate, now: Date): Promise<void> {
    const startedAt = Date.now();
    if (candidate.backfill) {
      await this.backfillDuration(candidate, startedAt);
      return;
    }
    const previousAttempts = candidate.sourceChanged
      ? 0
      : (candidate.attempts ?? 0);

    if (previousAttempts >= MAX_ATTEMPTS) {
      // The last run was claimed and never finished, so the failure is final.
      if (
        await this.settle(candidate, {
          ...this.failure(candidate, 'interrupted', now),
          claimedAt: null,
        })
      ) {
        this.finish(candidate, 'failure', startedAt, 'interrupted');
      }
      return;
    }

    const attempts = previousAttempts + 1;
    if (!(await this.claim(candidate, attempts, now))) return;

    if (!isHttpUrl(candidate.sourceUrl)) {
      await this.store({
        candidate,
        previousAttempts,
        data: this.failure(candidate, 'unsupported-source', now),
        outcome: 'failure',
        error: 'unsupported-source',
        analysisMs: Date.now() - startedAt,
        retries: 0,
      });
      return;
    }

    let analysis: AudioAnalysis;
    try {
      analysis = await this.analyzer.analyze(
        candidate.sourceUrl,
        ANALYSIS_TIMEOUT_MS,
        candidate.requestedRuleVersion === PREVIOUS_CUE_RULE_VERSION ||
          candidate.requestedRuleVersion === BOUND_KEEPS_RULE_VERSION
          ? candidate.requestedRuleVersion
          : CUE_RULE_VERSION,
      );
    } catch (error) {
      const failure =
        error instanceof AudioAnalysisError
          ? error
          : new AudioAnalysisError('decode-failed');
      const backoff = failure.retryable
        ? RETRY_BACKOFF_MS[attempts - 1]
        : undefined;
      const data = this.failure(candidate, failure.code, now, backoff);
      await this.store({
        candidate,
        previousAttempts,
        data,
        outcome: data.nextAttemptAt ? 'retry' : 'failure',
        error: failure.code,
        analysisMs: Date.now() - startedAt,
        retries: 0,
      });
      return;
    }

    this.metrics.recordCueRule(analysis.cueRule);
    await this.store({
      candidate,
      previousAttempts,
      outcome: 'success',
      analysisMs: Date.now() - startedAt,
      retries: 0,
      data: {
        status: 'success',
        cueInSeconds: analysis.cueInSeconds,
        cueOutSeconds: analysis.cueOutSeconds,
        fadeInSeconds: null,
        fadeOutSeconds: null,
        overlapSeconds: null,
        integratedLufs: analysis.integratedLufs,
        truePeakDbtp: analysis.truePeakDbtp,
        durationSeconds: storedDuration(analysis),
        isrc: analysis.isrc,
        musicbrainzRecordingId: analysis.musicbrainzRecordingId,
        ruleVersion: analysis.ruleVersion,
        requestedRuleVersion: null,
        error: null,
        nextAttemptAt: null,
      },
    });
  }

  // Stores the result of a claimed run. A transient database error does not
  // lose a finished analysis: the result is held and the next runs retry the
  // write, a bounded number of times, before another asset is taken (#278).
  // Any other error is final for this result and is logged as an error.
  private async store(result: HeldResult, now = new Date()): Promise<void> {
    try {
      await this.write(result.candidate, result.data);
    } catch (error) {
      await this.writeFailed(result, error, now);
      return;
    }
    this.held = null;
    if (result.retries > 0) this.metrics.recordWrite('stored_after_retry');
    this.finish(
      result.candidate,
      result.outcome,
      Date.now() - result.analysisMs,
      result.error,
    );
  }

  private async retryHeld(result: HeldResult, now: Date): Promise<void> {
    await this.store({ ...result, retries: result.retries + 1 }, now);
  }

  private async writeFailed(
    result: HeldResult,
    error: unknown,
    now: Date,
  ): Promise<void> {
    const cause = errorCause(error);
    if (!isTransientDatabaseError(error)) {
      // A write that cannot succeed is not retried. Nothing is held: the lease
      // runs out and the asset is taken up again as before.
      this.held = null;
      this.metrics.recordWrite('dropped');
      this.logger.error(
        `Media analysis could not store the result of a file (${cause})`,
      );
      return;
    }
    if (result.retries < MAX_WRITE_RETRIES) {
      this.held = result;
      this.metrics.recordWrite('retried');
      this.logger.warn(
        `Media analysis could not store a finished result (${cause}); retrying on the next run (${result.retries + 1} of ${MAX_WRITE_RETRIES})`,
      );
      return;
    }
    this.held = null;
    await this.release(result, cause, now);
  }

  // Gives the claim back with the attempt the asset had, so a write the
  // database lost is not counted as an attempt. The asset waits the first retry
  // backoff, so a database that keeps refusing it does not starve the others.
  // If this write fails too, the lease runs out and the asset is taken up again.
  private async release(
    result: HeldResult,
    cause: string,
    now: Date,
  ): Promise<void> {
    try {
      await this.prisma.mediaAssetAnalysis.updateMany({
        where: {
          assetId: result.candidate.assetId,
          sourceUrl: result.candidate.sourceUrl,
          status: keepsResult(result.candidate) ? 'success' : 'pending',
        },
        data: {
          attempts: result.previousAttempts,
          claimedAt: null,
          nextAttemptAt: new Date(now.getTime() + RETRY_BACKOFF_MS[0]),
        },
      });
    } catch (error) {
      this.metrics.recordWrite('dropped');
      this.logger.warn(
        `Media analysis could not release the claim of a finished result (${errorCause(error)}); the lease runs out and the file is analysed again`,
      );
      return;
    }
    this.metrics.recordWrite('released');
    this.logger.warn(
      `Media analysis gave up storing a finished result (${cause}) after ${MAX_WRITE_RETRIES} retries; the file is analysed again without spending an attempt`,
    );
  }

  // Measures an analysed asset again only to store its length (#296). The row stays a
  // success and keeps its cue points and loudness whatever happens: a run that fails changes
  // nothing but the attempt count, and touching the row also keeps every instance from taking
  // it again before BACKFILL_RETRY_AFTER_MS.
  private async backfillDuration(
    candidate: Candidate,
    startedAt: number,
  ): Promise<void> {
    const { count } = await this.prisma.mediaAssetAnalysis.updateMany({
      where: {
        assetId: candidate.assetId,
        updatedAt: candidate.analysisUpdatedAt!,
        status: 'success',
        durationSeconds: null,
      },
      data: { attempts: (candidate.attempts ?? 0) + 1 },
    });
    if (count !== 1) return;

    let analysis: AudioAnalysis | null = null;
    let code: FailureCode = 'unsupported-source';
    if (isHttpUrl(candidate.sourceUrl)) {
      try {
        analysis = await this.analyzer.analyze(
          candidate.sourceUrl,
          ANALYSIS_TIMEOUT_MS,
        );
      } catch (error) {
        code =
          error instanceof AudioAnalysisError ? error.code : 'decode-failed';
      }
    }
    const seconds = analysis ? storedDuration(analysis) : null;
    if (seconds === null) {
      this.finish(candidate, 'retry', startedAt, code);
      return;
    }
    await this.prisma.mediaAssetAnalysis.updateMany({
      where: {
        assetId: candidate.assetId,
        sourceUrl: candidate.sourceUrl,
        status: 'success',
        durationSeconds: null,
      },
      data: { durationSeconds: seconds },
    });
    this.finish(candidate, 'success', startedAt);
  }

  // A failed row keeps no measurement. It is retried after the backoff when one
  // is given: never after the last run or a failure that cannot change.
  private failure(
    candidate: Candidate,
    code: FailureCode,
    now: Date,
    backoff?: number,
  ): Prisma.MediaAssetAnalysisUpdateManyMutationInput {
    const nextAttemptAt =
      backoff === undefined ? null : new Date(now.getTime() + backoff);
    // A re-run that failed records why and keeps what the last good run measured; a final failure also drops the
    // requested rule, so a later request starts from the current one.
    if (keepsResult(candidate)) {
      return {
        error: code,
        nextAttemptAt,
        ...(nextAttemptAt ? {} : { requestedRuleVersion: null }),
      };
    }
    return {
      status: 'failed',
      ...EMPTY_MEASUREMENT,
      error: code,
      nextAttemptAt,
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
      // A re-run of a good result stays a success, so playout keeps its cues and loudness while it runs.
      status: keepsResult(candidate) ? 'success' : 'pending',
      attempts,
      nextAttemptAt: new Date(now.getTime() + LEASE_MS),
      claimedAt: now,
      ...(candidate.sourceChanged ? { interruptions: 0 } : {}),
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
        status: keepsResult(candidate) ? 'success' : 'pending',
      },
      // The run is over, whatever it found; a good result also clears the interruptions before it.
      data: {
        ...data,
        claimedAt: null,
        ...(data.error === null ? { interruptions: 0 } : {}),
      },
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
