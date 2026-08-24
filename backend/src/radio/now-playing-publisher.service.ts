import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { SongPlaybackData } from './song-execution.engine';

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

  constructor(private readonly prisma: PrismaService) {}

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

    const records = consumers.map((consumer, index) =>
      this.normalizeConsumerPayload(consumer, index),
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
    const artworkUrl = await this.resolveArtworkUrl(playback);
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
    playback: SongPlaybackData,
  ): Promise<string | undefined> {
    const supplied = this.normalizeString(playback.coverUrl);
    if (supplied) return supplied;
    const audioUrl = this.normalizeString(playback.audioUrl);
    if (!audioUrl) return undefined;
    try {
      const song = await this.prisma.song.findFirst({
        where: { audioUrl },
        select: { coverUrl: true },
      });
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

    return {
      name: this.normalizeString(consumer.name) ?? `consumer-${index + 1}`,
      url,
      method: this.normalizeMethod(consumer.method),
      headers: this.normalizeHeaders(consumer.headers),
      enabled: consumer.enabled !== false,
      position: index,
    };
  }

  private async publishToConsumers(
    programId: string,
    consumers: NowPlayingConsumerConfig[],
    payload: NowPlayingPublisherPayload,
  ): Promise<void> {
    await Promise.all(
      consumers.map((consumer) =>
        this.postNowPlaying(programId, consumer, payload),
      ),
    );
  }

  private async postNowPlaying(
    programId: string,
    consumer: NowPlayingConsumerConfig,
    payload: NowPlayingPublisherPayload,
  ): Promise<void> {
    this.logger.log(
      `Now-playing publish attempt for ${programId}/${consumer.name}: ${consumer.method} ${consumer.endpointUrl} ${JSON.stringify(payload)}`,
    );

    let response: Response;
    try {
      response = await fetch(consumer.endpointUrl, {
        method: consumer.method,
        headers: {
          'Content-Type': 'application/json',
          ...consumer.headers,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      this.logger.error(
        `Now-playing publish failed for ${programId}/${consumer.name}: ${err}`,
      );
      return;
    }

    if (response.ok) {
      this.logger.log(
        `Now-playing publish succeeded for ${programId}/${consumer.name}: ${response.status} ${response.statusText}`,
      );
      return;
    }

    let responseBody = '';
    try {
      responseBody = await response.text();
    } catch {
      responseBody = '<failed to read response body>';
    }
    this.logger.error(
      `Now-playing publish failed for ${programId}/${consumer.name}: ${response.status} ${response.statusText} ${responseBody}`,
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
