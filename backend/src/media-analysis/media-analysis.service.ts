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

/** Waits this long after startup before the first run. */
export const START_DELAY_MS = 30_000;
/** Gap between runs while there is work, so one run never follows another without a pause. */
export const BUSY_GAP_MS = 1_000;
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
    if (!(await this.analyzer.available(TOOL_CHECK_TIMEOUT_MS))) {
      this.logger.error(
        'Media analysis is not scheduled: ffmpeg or ffprobe is not installed',
      );
      return;
    }
    this.logger.log('Media analysis is scheduled');
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

  private async tick(): Promise<void> {
    let worked = false;
    try {
      worked = await this.runOnce();
    } catch {
      this.logger.error('Media analysis run failed before analysing a file');
    }
    this.schedule(worked ? BUSY_GAP_MS : IDLE_POLL_MS);
  }

  /** Analyses at most one asset. Returns whether an asset was handled. */
  async runOnce(now = new Date()): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const candidate = await this.nextCandidate(now);
      if (!candidate) return false;
      await this.handle(candidate, now);
      return true;
    } finally {
      this.running = false;
    }
  }

  // The newest audio asset that has no analysis, whose analysis describes another
  // source URL, or whose retry or lease time has come.
  private async nextCandidate(now: Date): Promise<Candidate | null> {
    const rows = await this.prisma.$queryRaw<Candidate[]>(Prisma.sql`
      SELECT a."id" AS "assetId",
             a."sourceUrl" AS "sourceUrl",
             m."updatedAt" AS "analysisUpdatedAt",
             m."attempts" AS "attempts",
             (m."assetId" IS NOT NULL AND m."sourceUrl" IS DISTINCT FROM a."sourceUrl") AS "sourceChanged"
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
