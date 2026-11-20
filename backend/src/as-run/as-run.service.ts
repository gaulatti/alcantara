import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Subscription } from 'rxjs';
import { PrismaService } from '../prisma.service';
import { SongExecutionEngine } from '../radio/song-execution.engine';
import { RadioMetricsService } from '../radio/radio-metrics.service';
import {
  AS_RUN_ACTOR_VIAS,
  AS_RUN_END_REASONS,
  AS_RUN_UNCOUNTED_END_REASONS,
  AS_RUN_SHORT_INFERRED_PLAY_MS,
  type AsRunExportQuery,
  type AsRunInferredFilter,
  type AsRunReviewFlag,
  type AsRunTrackEvent,
} from './as-run.types';

const INFERRED_FILTERS: readonly string[] = ['include', 'only', 'exclude'];

export function escapeCsvField(
  value: string | number | boolean | Date | null | undefined,
): string {
  if (value === null || value === undefined) return '';
  const str =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'string'
        ? value
        : `${value}`;
  if (
    str.includes(',') ||
    str.includes('"') ||
    str.includes('\n') ||
    str.includes('\r')
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

@Injectable()
export class AsRunService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AsRunService.name);
  private subscription?: Subscription;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly engine?: SongExecutionEngine,
    @Optional() private readonly radioMetrics?: RadioMetricsService,
  ) {}

  onModuleInit(): void {
    const engine = this.engine;
    if (engine && 'trackEvents$' in engine) {
      const trackEvents$ = (engine as { trackEvents$?: unknown }).trackEvents$;
      if (
        trackEvents$ &&
        typeof (trackEvents$ as { subscribe?: unknown }).subscribe ===
          'function'
      ) {
        this.subscription = (
          trackEvents$ as {
            subscribe: (observer: {
              next: (event: AsRunTrackEvent) => void;
              error: (err: unknown) => void;
            }) => Subscription;
          }
        ).subscribe({
          next: (event: AsRunTrackEvent) => {
            void this.handleTrackEvent(event).catch((err: unknown) => {
              this.logger.error(`Failed to record track event: ${String(err)}`);
            });
          },
          error: (err: unknown) => {
            this.logger.error(`Error in trackEvents$ stream: ${String(err)}`);
          },
        });
      }
    }
  }

  onModuleDestroy(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
    }
  }

  async handleTrackEvent(event: AsRunTrackEvent) {
    if (
      !event ||
      typeof event.programId !== 'string' ||
      !event.programId ||
      (event.type !== 'track.started' && event.type !== 'track.ended')
    ) {
      return null;
    }

    const state = event.type === 'track.started' ? 'started' : 'ended';
    const at =
      event.at instanceof Date && !Number.isNaN(event.at.getTime())
        ? event.at
        : new Date(event.at);
    const playbackRequestId =
      typeof event.playbackRequestId === 'string' && event.playbackRequestId
        ? event.playbackRequestId
        : null;

    // One record per play and state: a late real end after an inferred one
    // (or any repeated event) must not become a second performance.
    if (playbackRequestId) {
      const existing = await this.prisma.asRunRecord.findFirst({
        where: { programId: event.programId, playbackRequestId, state },
        select: { id: true },
      });
      if (existing) return null;
    }

    const { songId, assetId } = await this.resolveSongAndAsset(event);
    // A start is inferred only when the engine adopted the play from a
    // snapshot (#174); an end when the engine inferred it.
    const inferred = event.inferred === true;
    const endReason =
      state === 'ended' &&
      typeof event.endReason === 'string' &&
      AS_RUN_END_REASONS.includes(event.endReason)
        ? event.endReason
        : null;
    // Attribution is stored only when the engine named a known channel; an
    // automatic transition carries none and keeps all three columns NULL.
    const actorVia =
      typeof event.actorVia === 'string' &&
      AS_RUN_ACTOR_VIAS.includes(event.actorVia)
        ? event.actorVia
        : null;
    const actor = actorVia
      ? {
          actorVia,
          actorPrincipalId:
            typeof event.actorPrincipalId === 'string' && event.actorPrincipalId
              ? event.actorPrincipalId
              : null,
          actorClient:
            typeof event.actorClient === 'string' && event.actorClient
              ? event.actorClient
              : null,
        }
      : {};
    // Inferred ends and ends the engine caused are flagged, never dropped.
    const reviewFlag =
      state === 'ended' && (inferred || endReason)
        ? await this.inferredReviewFlag(event.programId, playbackRequestId, at)
        : null;

    const record = await this.prisma.asRunRecord
      .create({
        data: {
          programId: event.programId,
          songId,
          assetId,
          state,
          at,
          playbackRequestId,
          inferred,
          reviewFlag,
          // Omitted rather than null when absent: the column defaults to NULL.
          ...(endReason ? { endReason } : {}),
          ...actor,
        },
      })
      .catch((error: unknown) => {
        // A concurrent write recorded this play and state first.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          return null;
        }
        throw error;
      });
    if (!record) return null;

    if (state === 'ended') {
      this.radioMetrics?.recordRadioLogResult('completed');
    }

    return record;
  }

  /**
   * Flags an inferred or engine-caused end for review when its start is
   * unknown or it closes a play shorter than AS_RUN_SHORT_INFERRED_PLAY_MS.
   * The play still counts.
   */
  async inferredReviewFlag(
    programId: string,
    playbackRequestId: string | null,
    at: Date,
  ): Promise<AsRunReviewFlag | null> {
    if (!playbackRequestId) return 'no-start';
    const started = await this.prisma.asRunRecord.findFirst({
      where: { programId, playbackRequestId, state: 'started' },
      select: { at: true },
    });
    if (!started) return 'no-start';
    return at.getTime() - started.at.getTime() < AS_RUN_SHORT_INFERRED_PLAY_MS
      ? 'short'
      : null;
  }

  async record(data: {
    programId: string;
    songId?: number | null;
    assetId?: string | null;
    state: string;
    at: Date;
  }) {
    const record = await this.prisma.asRunRecord.create({
      data: {
        programId: data.programId,
        songId:
          typeof data.songId === 'number' && Number.isInteger(data.songId)
            ? data.songId
            : null,
        assetId:
          typeof data.assetId === 'string' && data.assetId
            ? data.assetId
            : null,
        state: data.state,
        at: data.at instanceof Date ? data.at : new Date(data.at),
      },
    });

    if (data.state === 'ended') {
      this.radioMetrics?.recordRadioLogResult('completed');
    }

    return record;
  }

  async resolveSongAndAsset(event: AsRunTrackEvent): Promise<{
    songId: number | null;
    assetId: string | null;
  }> {
    if (event.url) {
      const songByUrl = await this.prisma.song.findFirst({
        where: { audioUrl: event.url },
        select: { id: true, assetId: true },
      });
      if (songByUrl) {
        return { songId: songByUrl.id, assetId: songByUrl.assetId };
      }

      const assetByUrl = await this.prisma.mediaAsset.findFirst({
        where: { sourceUrl: event.url },
        select: { id: true },
      });
      if (assetByUrl) {
        return { songId: null, assetId: assetByUrl.id };
      }
    }

    if (event.title && event.artist) {
      const songByMetadata = await this.prisma.song.findFirst({
        where: { title: event.title, artist: event.artist },
        select: { id: true, assetId: true },
      });
      if (songByMetadata) {
        return { songId: songByMetadata.id, assetId: songByMetadata.assetId };
      }
    }

    return { songId: null, assetId: null };
  }

  parseExportDates(query: AsRunExportQuery): { from?: Date; to?: Date } {
    let from: Date | undefined;
    let to: Date | undefined;

    if (query.from !== undefined) {
      const parsedFrom = Date.parse(query.from);
      if (Number.isNaN(parsedFrom)) {
        throw new BadRequestException('Invalid from date');
      }
      from = new Date(parsedFrom);
    }

    if (query.to !== undefined) {
      const parsedTo = Date.parse(query.to);
      if (Number.isNaN(parsedTo)) {
        throw new BadRequestException('Invalid to date');
      }
      to = new Date(parsedTo);
    }

    return { from, to };
  }

  async export(programId: string, query: AsRunExportQuery): Promise<string> {
    const rawFormat = (query.format || 'csv').toLowerCase();
    if (rawFormat !== 'csv' && rawFormat !== 'soundexchange') {
      throw new BadRequestException('format must be csv or soundexchange');
    }

    const { from, to } = this.parseExportDates(query);

    if (rawFormat === 'csv') {
      if (query.inferred !== undefined) {
        throw new BadRequestException(
          'inferred applies only to format=soundexchange',
        );
      }
      return this.exportCsv(programId, from, to);
    }

    const inferred = (query.inferred ?? 'include').toLowerCase();
    if (!INFERRED_FILTERS.includes(inferred)) {
      throw new BadRequestException(
        'inferred must be include, only or exclude',
      );
    }

    return this.exportSoundExchange(
      programId,
      from,
      to,
      inferred as AsRunInferredFilter,
    );
  }

  async exportCsv(programId: string, from?: Date, to?: Date): Promise<string> {
    const atFilter: { gte?: Date; lte?: Date } = {};
    if (from) atFilter.gte = from;
    if (to) atFilter.lte = to;

    const records = await this.prisma.asRunRecord.findMany({
      where: {
        programId,
        ...(from || to ? { at: atFilter } : {}),
      },
      orderBy: { at: 'asc' },
    });

    const songIds = Array.from(
      new Set(
        records
          .map((r) => r.songId)
          .filter((id): id is number => typeof id === 'number'),
      ),
    );

    const songs = songIds.length
      ? await this.prisma.song.findMany({
          where: { id: { in: songIds } },
          select: { id: true, title: true, artist: true },
        })
      : [];

    const songMap = new Map(songs.map((s) => [s.id, s]));

    const header = [
      'id',
      'programId',
      'songId',
      'assetId',
      'title',
      'artist',
      'state',
      'at',
      'createdAt',
      'inferred',
      'reviewFlag',
      'endReason',
      'actorPrincipalId',
      'actorVia',
      'actorClient',
    ].join(',');

    const lines = [header];

    for (const r of records) {
      const song = r.songId !== null ? songMap.get(r.songId) : undefined;
      const title = song?.title ?? '';
      const artist = song?.artist ?? '';

      const row = [
        escapeCsvField(r.id),
        escapeCsvField(r.programId),
        escapeCsvField(r.songId),
        escapeCsvField(r.assetId),
        escapeCsvField(title),
        escapeCsvField(artist),
        escapeCsvField(r.state),
        escapeCsvField(r.at.toISOString()),
        escapeCsvField(r.createdAt.toISOString()),
        escapeCsvField(r.inferred === true),
        escapeCsvField(r.reviewFlag),
        escapeCsvField(r.endReason),
        escapeCsvField(r.actorPrincipalId),
        escapeCsvField(r.actorVia),
        escapeCsvField(r.actorClient),
      ].join(',');

      lines.push(row);
    }

    return lines.join('\n');
  }

  async exportSoundExchange(
    programId: string,
    from?: Date,
    to?: Date,
    inferred: AsRunInferredFilter = 'include',
  ): Promise<string> {
    const atFilter: { gte?: Date; lte?: Date } = {};
    if (from) atFilter.gte = from;
    if (to) atFilter.lte = to;

    // Inferred ends count as performances; `only` and `exclude` list them
    // separately from ends that are not inferred (Palazzo's reported ends,
    // operator stops and manual cuts). A superseded end is inferred.
    // In SoundExchange Report of Use, performances are based on completed plays (state = 'ended')
    const records = (
      await this.prisma.asRunRecord.findMany({
        where: {
          programId,
          state: 'ended',
          ...(from || to ? { at: atFilter } : {}),
          ...(inferred === 'include' ? {} : { inferred: inferred === 'only' }),
        },
        orderBy: { at: 'asc' },
      })
    ).filter(
      // A preempted announced song is recorded, never counted.
      (r) => !AS_RUN_UNCOUNTED_END_REASONS.includes(r.endReason ?? ''),
    );

    const songIds = Array.from(
      new Set(
        records
          .map((r) => r.songId)
          .filter((id): id is number => typeof id === 'number'),
      ),
    );

    const assetIds = Array.from(
      new Set(
        records
          .map((r) => r.assetId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    );

    const songs = songIds.length
      ? await this.prisma.song.findMany({
          where: { id: { in: songIds } },
          select: { id: true, title: true, artist: true },
        })
      : [];

    const assets = assetIds.length
      ? await this.prisma.mediaAsset.findMany({
          where: { id: { in: assetIds } },
          select: { id: true, name: true },
        })
      : [];

    const songMap = new Map(songs.map((s) => [s.id, s]));
    const assetMap = new Map(assets.map((a) => [a.id, a]));

    // Aggregate performances by unique sound recording
    const performanceCounts = new Map<
      string,
      { count: number; record: (typeof records)[0] }
    >();

    for (const r of records) {
      const key =
        r.songId !== null
          ? `song:${r.songId}`
          : r.assetId !== null
            ? `asset:${r.assetId}`
            : `record:${r.id}`;

      const existing = performanceCounts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        performanceCounts.set(key, { count: 1, record: r });
      }
    }

    const header = [
      'Transmission Category Code',
      'Featured Artist Name',
      'Sound Recording Title',
      'ISRC',
      'Album Title',
      'Marketing Label',
      'Actual Total Performances',
    ].join(',');

    const lines = [header];

    for (const { count, record } of performanceCounts.values()) {
      const song =
        record.songId !== null ? songMap.get(record.songId) : undefined;
      const asset =
        record.assetId !== null ? assetMap.get(record.assetId) : undefined;

      const artist = song?.artist ?? '';
      const title = song?.title ?? asset?.name ?? '';
      // Plays lacking an ISRC are listed as gaps (empty string field in SoundExchange layout)
      const isrc = '';
      const albumTitle = '';
      const marketingLabel = '';
      const categoryCode = 'E'; // Eligible nonsubscription transmission (37 CFR § 370.4)

      const row = [
        escapeCsvField(categoryCode),
        escapeCsvField(artist),
        escapeCsvField(title),
        escapeCsvField(isrc),
        escapeCsvField(albumTitle),
        escapeCsvField(marketingLabel),
        escapeCsvField(count),
      ].join(',');

      lines.push(row);
    }

    return lines.join('\n');
  }
}
