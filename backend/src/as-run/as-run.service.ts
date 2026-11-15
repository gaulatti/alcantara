import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { PrismaService } from '../prisma.service';
import { SongExecutionEngine } from '../radio/song-execution.engine';
import { RadioMetricsService } from '../radio/radio-metrics.service';
import type { AsRunExportQuery, AsRunTrackEvent } from './as-run.types';

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

    const { songId, assetId } = await this.resolveSongAndAsset(event);
    const state = event.type === 'track.started' ? 'started' : 'ended';
    const at =
      event.at instanceof Date && !Number.isNaN(event.at.getTime())
        ? event.at
        : new Date(event.at);

    const record = await this.prisma.asRunRecord.create({
      data: {
        programId: event.programId,
        songId,
        assetId,
        state,
        at,
      },
    });

    if (state === 'ended') {
      this.radioMetrics?.recordRadioLogResult('completed');
    }

    return record;
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
      return this.exportCsv(programId, from, to);
    }

    return this.exportSoundExchange(programId, from, to);
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
      ].join(',');

      lines.push(row);
    }

    return lines.join('\n');
  }

  async exportSoundExchange(
    programId: string,
    from?: Date,
    to?: Date,
  ): Promise<string> {
    const atFilter: { gte?: Date; lte?: Date } = {};
    if (from) atFilter.gte = from;
    if (to) atFilter.lte = to;

    // In SoundExchange Report of Use, performances are based on completed plays (state = 'ended')
    const records = await this.prisma.asRunRecord.findMany({
      where: {
        programId,
        state: 'ended',
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
