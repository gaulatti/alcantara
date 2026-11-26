import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isProductionEnvironment } from '../config/local-media';
import { PrismaService } from '../prisma.service';
import { PlayoutSongScope } from './playout-song-scope';
import type { SongPlaybackData } from './song-execution.engine';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  OutboundRefusal,
  safeFetch,
  type SafeFetchDeps,
} from '../outbound/safe-fetch';

type NowPlayingMethod = 'POST' | 'PUT' | 'PATCH';

export interface NowPlayingConsumerPayload {
  name?: string;
  url: string;
  method?: string;
  headers?: unknown;
  enabled?: boolean;
}

interface NowPlayingConsumerConfig {
  name: string;
  endpointUrl: string;
  method: NowPlayingMethod;
  headers: Record<string, string>;
}

type NowPlayingPublisherPayload =
  | {
      title?: string;
      artist?: string;
      album?: string;
      artworkUrl?: string;
      startedAt?: string;
      durationSeconds?: number;
    }
  | { status: 'stopped' };

@Injectable()
export class NowPlayingPublisherService {
  private readonly logger = new Logger(NowPlayingPublisherService.name);

  // Test seam: the resolver and transport the request policy uses.
  outboundDeps: Omit<SafeFetchDeps, 'record'> = {};

  private static readonly DELIVERY_TIMEOUT_MS = 10_000;
  private static readonly DELIVERY_MAX_REDIRECTS = 3;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly metrics?: ManagedMetricsService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly songScope?: PlayoutSongScope,
  ) {}

  /**
   * Outside production no now-playing update leaves the machine
   * (gaulatti/alcantara#206): a consumer an operator enters on a local stack
   * may be a real endpoint. Production always publishes.
   */
  outboundPublishing(): 'enabled' | 'blocked-local' {
    if (!this.config) return 'enabled';
    return isProductionEnvironment({
      NODE_ENV: this.config.get<string>('NODE_ENV'),
    })
      ? 'enabled'
      : 'blocked-local';
  }

  async listConsumers(programId: string) {
    return this.prisma.nowPlayingConsumer.findMany({
      where: {
        programState: { programId: this.normalizeProgramId(programId) },
      },
      orderBy: { position: 'asc' },
    });
  }

  async replaceConsumers(
    programId: string,
    consumers: NowPlayingConsumerPayload[],
  ) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.prisma.programState.findUnique({
      where: { programId: normalizedProgramId },
      select: { id: true },
    });
    if (!state) throw new Error('Program not found');

    // A stored http address that is submitted again unchanged keeps
    // delivering (to public addresses only); a new or changed one must be
    // https.
    const stored = await this.prisma.nowPlayingConsumer.findMany({
      where: { programStateId: state.id },
      select: { url: true },
    });
    const storedUrls = new Set(stored.map((consumer) => consumer.url));
    const records = consumers.map((consumer, index) =>
      this.normalizeConsumerPayload(consumer, index, storedUrls),
    );

    await this.prisma.$transaction([
      this.prisma.nowPlayingConsumer.deleteMany({
        where: { programStateId: state.id },
      }),
      ...records.map((consumer) =>
        this.prisma.nowPlayingConsumer.create({
          data: {
            programStateId: state.id,
            name: consumer.name,
            url: consumer.url,
            method: consumer.method,
            headers: consumer.headers,
            enabled: consumer.enabled,
            position: consumer.position,
          },
        }),
      ),
    ]);

    return this.listConsumers(normalizedProgramId);
  }

  async publishPlayback(
    programId: string,
    playback: SongPlaybackData,
  ): Promise<void> {
    this.logger.log(
      `Now-playing playback event for ${programId}: ${JSON.stringify({
        title: playback.title,
        artist: playback.artist,
        startedAt: playback.startedAt,
        durationMs: playback.durationMs,
      })}`,
    );

    const consumers = await this.getProgramConsumers(programId);
    if (!consumers.length) {
      this.logger.warn(
        `Now-playing publish skipped for ${programId}: no enabled consumers`,
      );
      return;
    }

    const payload: NowPlayingPublisherPayload = {};
    const artworkUrl = await this.resolveArtworkUrl(programId, playback);
    if (playback.title) payload.title = playback.title;
    if (playback.artist) payload.artist = playback.artist;
    if (artworkUrl) payload.artworkUrl = artworkUrl;
    if (playback.startedAt) payload.startedAt = playback.startedAt;
    if (playback.durationMs > 0) {
      payload.durationSeconds = Math.round(playback.durationMs / 1000);
    }

    await this.publishToConsumers(programId, consumers, payload);
  }

  private async resolveArtworkUrl(
    programId: string,
    playback: SongPlaybackData,
  ): Promise<string | undefined> {
    const supplied = this.normalizeString(playback.coverUrl);
    if (supplied) return supplied;
    const audioUrl = this.normalizeString(playback.audioUrl);
    if (!audioUrl) return undefined;
    try {
      const byUrl = (db: PrismaService) =>
        db.song.findFirst({
          where: { audioUrl },
          select: { coverUrl: true },
        });
      const song = this.songScope
        ? await this.songScope.read('artwork', programId, byUrl, (row) => !!row)
        : await byUrl(this.prisma);
      return this.normalizeString(song?.coverUrl) ?? undefined;
    } catch (err) {
      this.logger.warn(
        `Now-playing artwork lookup failed for ${playback.title || 'unknown track'}: ${err}`,
      );
      return undefined;
    }
  }

  async publishStopped(programId: string): Promise<void> {
    this.logger.log(`Now-playing stopped event for ${programId}`);

    const consumers = await this.getProgramConsumers(programId);
    if (!consumers.length) {
      this.logger.warn(
        `Now-playing publish skipped for ${programId}: no enabled consumers`,
      );
      return;
    }

    await this.publishToConsumers(programId, consumers, { status: 'stopped' });
  }

  private async getProgramConsumers(
    programId: string,
  ): Promise<NowPlayingConsumerConfig[]> {
    const consumers = await this.prisma.nowPlayingConsumer.findMany({
      where: {
        enabled: true,
        programState: { programId: this.normalizeProgramId(programId) },
      },
      orderBy: { position: 'asc' },
    });

    return consumers.map((consumer) => ({
      name: consumer.name,
      endpointUrl: consumer.url,
      method: this.normalizeMethod(consumer.method),
      headers: this.normalizeHeaders(consumer.headers),
    }));
  }

  private normalizeConsumerPayload(
    consumer: NowPlayingConsumerPayload,
    index: number,
    storedUrls: Set<string>,
  ): {
    name: string;
    url: string;
    method: NowPlayingMethod;
    headers: Record<string, string>;
    enabled: boolean;
    position: number;
  } {
    const url = this.normalizeString(consumer.url);
    if (!url) throw new Error(`Consumer ${index + 1} requires url`);
    this.assertDeliveryUrl(url, index, storedUrls);

    return {
      name: this.normalizeString(consumer.name) ?? `consumer-${index + 1}`,
      url,
      method: this.normalizeMethod(consumer.method),
      headers: this.normalizeHeaders(consumer.headers),
      enabled: consumer.enabled !== false,
      position: index,
    };
  }

  /**
   * A consumer address must be an absolute https URL with no user name or
   * password. The message names the consumer, never the address.
   */
  private assertDeliveryUrl(
    url: string,
    index: number,
    storedUrls: Set<string>,
  ): void {
    const label = `Consumer ${index + 1}`;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${label}: the URL is not a valid absolute URL.`);
    }
    if (parsed.username || parsed.password)
      throw new Error(
        `${label}: the URL must not include a user name or password.`,
      );
    if (parsed.protocol === 'https:') return;
    if (parsed.protocol === 'http:' && storedUrls.has(url)) return;
    throw new Error(`${label}: the URL must use https.`);
  }

  private async publishToConsumers(
    programId: string,
    consumers: NowPlayingConsumerConfig[],
    payload: NowPlayingPublisherPayload,
  ): Promise<void> {
    if (this.outboundPublishing() === 'blocked-local') {
      const started = process.hrtime.bigint();
      for (let i = 0; i < consumers.length; i++) {
        this.recordPublishMetric('skipped', started);
      }
      this.logger.warn(
        `Now-playing publish blocked for ${programId}: outbound publishing is off outside production (${consumers.length} consumer(s) not contacted)`,
      );
      return;
    }
    await Promise.all(
      consumers.map((consumer) =>
        this.postNowPlaying(programId, consumer, payload),
      ),
    );
  }

  /**
   * One delivery under the outbound-request policy: public addresses only
   * (checked after DNS and on each redirect, the connection made to the
   * checked address), one deadline, the answer not read. A stored plain-http
   * consumer still delivers, to a public address only, and is counted as
   * legacy_http. No log line carries the address or the payload.
   */
  private async postNowPlaying(
    programId: string,
    consumer: NowPlayingConsumerConfig,
    payload: NowPlayingPublisherPayload,
  ): Promise<void> {
    const started = process.hrtime.bigint();
    const target = `${programId}/${consumer.name}`;
    this.logger.log(
      `Now-playing publish attempt for ${target}: ${consumer.method}`,
    );

    try {
      const response = await safeFetch(
        consumer.endpointUrl,
        {
          path: 'now_playing',
          method: consumer.method,
          headers: {
            'Content-Type': 'application/json',
            ...consumer.headers,
          },
          body: JSON.stringify(payload),
          maxBytes: 0,
          timeoutMs: NowPlayingPublisherService.DELIVERY_TIMEOUT_MS,
          maxRedirects: NowPlayingPublisherService.DELIVERY_MAX_REDIRECTS,
          allowContentType: () => true,
          readBody: false,
          allowLegacyHttp: true,
        },
        {
          ...this.outboundDeps,
          record: (path, result) =>
            this.metrics?.recordOutboundFetch(path, result),
        },
      );
      this.recordPublishMetric('success', started);
      this.logger.log(
        `Now-playing publish succeeded for ${target}: ${response.status}`,
      );
      if (response.legacyHttp)
        this.logger.warn(
          `Now-playing consumer ${target} uses plain http; change its URL to https`,
        );
    } catch (error) {
      // safeFetch only ever throws an OutboundRefusal.
      const { reason, upstreamStatus } = error as OutboundRefusal;
      this.recordPublishMetric(
        reason === 'http_status' ? 'http-error' : 'unavailable',
        started,
      );
      this.logger.error(
        `Now-playing publish failed for ${target}: ${reason}${
          upstreamStatus ? ` ${upstreamStatus}` : ''
        }`,
      );
    }
  }

  private recordPublishMetric(
    result: 'success' | 'http-error' | 'unavailable' | 'skipped',
    started: bigint,
  ): void {
    this.metrics?.recordDependency(
      'now-playing',
      'publish',
      result,
      Number(process.hrtime.bigint() - started) / 1_000_000_000,
    );
  }

  private normalizeString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized || null;
  }

  private normalizeMethod(value: unknown): NowPlayingMethod {
    if (value === 'PUT' || value === 'PATCH') return value;
    return 'POST';
  }

  private normalizeHeaders(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    const headers: Record<string, string> = {};
    for (const [key, headerValue] of Object.entries(value)) {
      const normalizedKey = key.trim();
      const normalizedValue = this.normalizeString(headerValue);
      if (normalizedKey && normalizedValue) {
        headers[normalizedKey] = normalizedValue;
      }
    }
    return headers;
  }

  private normalizeProgramId(programId: string): string {
    const normalized = programId.trim();
    return normalized || 'main';
  }
}
