import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  PalazzoPlaybackState,
  PalazzoMixerState,
} from './palazzo-contract';
import { parsePalazzoMixerState, parsePalazzoState } from './palazzo-contract';
import {
  RadioMetricsService,
  type PalazzoMachineOperation,
  type PalazzoMachineResult,
} from './radio-metrics.service';
import {
  isValidPalazzoControlToken,
  normalizePalazzoBaseUrl,
} from '../config/runtime-secrets';

export class PalazzoMachineError extends Error {
  constructor(
    readonly reason: PalazzoMachineResult,
    readonly status?: number,
  ) {
    super(reason);
  }
}

export interface PalazzoSongCommand {
  playbackId: string;
  url: string;
  title?: string;
  artist?: string;
  coverUrl?: string;
  intro?: PalazzoIntroCommand;
}

export interface PalazzoIntroCommand {
  playbackId: string;
  url: string;
  gain?: number;
  duckGain?: number;
  fadeInSeconds?: number;
  fadeOutSeconds?: number;
}

export interface PalazzoInstantCommand {
  playbackId: string;
  url: string;
  volume?: number;
}

interface RequestOptions {
  operation: PalazzoMachineOperation;
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  idempotencyKey?: string;
  lastEventId?: string;
  signal?: AbortSignal;
  retryable?: boolean;
}

const MAX_ATTEMPTS = 3;

/**
 * Sole transport boundary for Palazzo's authenticated, program-scoped API.
 * Browser code never receives this client or its bearer credential.
 */
@Injectable()
export class PalazzoMachineClient {
  private readonly token: string;
  private readonly allowedUrls: ReadonlySet<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(
    config: ConfigService,
    private readonly metrics: RadioMetricsService,
    @Optional() @Inject('PALAZZO_FETCH') fetchImpl?: typeof fetch,
  ) {
    const nodeEnvironment = config.get<string>('NODE_ENV') ?? 'development';
    const token =
      config.get<string>('PALAZZO_CONTROL_TOKEN')?.trim() ||
      (nodeEnvironment === 'test' ? 'palazzo-test-control-token' : '');
    const configuredUrls =
      config.get<string>('PALAZZO_ALLOWED_URLS')?.trim() ||
      (nodeEnvironment === 'test' ? 'http://palazzo:3100' : '');
    if (!isValidPalazzoControlToken(token)) {
      throw new Error('PALAZZO_CONTROL_TOKEN is missing or invalid');
    }
    const allowedUrls = configuredUrls
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map(normalizePalazzoBaseUrl);
    if (!allowedUrls.length) {
      throw new Error('PALAZZO_ALLOWED_URLS must contain an approved URL');
    }
    this.token = token;
    this.allowedUrls = new Set(allowedUrls);
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  validateBaseUrl(value: string): string {
    let normalized: string;
    try {
      normalized = normalizePalazzoBaseUrl(value);
    } catch {
      throw new PalazzoMachineError('rejected');
    }
    if (!this.allowedUrls.has(normalized)) {
      throw new PalazzoMachineError('rejected');
    }
    return normalized;
  }

  async playSong(
    palazzoUrl: string,
    programId: string,
    command: PalazzoSongCommand,
  ): Promise<{
    playbackRequestId: string;
    duplicate: boolean;
    introPlaybackId?: string | null;
  }> {
    const response = await this.request(
      palazzoUrl,
      programId,
      '/playback/song',
      {
        operation: 'song-play',
        method: 'POST',
        idempotencyKey: command.playbackId,
        retryable: true,
        body: {
          song: {
            programId,
            playbackId: command.playbackId,
            url: command.url,
            title: command.title,
            artist: command.artist,
            coverUrl: command.coverUrl,
          },
          ...(command.intro && {
            intro: {
              programId,
              playbackId: command.intro.playbackId,
              url: command.intro.url,
              gain: command.intro.gain,
              duckGain: command.intro.duckGain,
              fadeInSeconds: command.intro.fadeInSeconds,
              fadeOutSeconds: command.intro.fadeOutSeconds,
            },
          }),
        },
      },
    );
    const body = await responseJson(response, 'song-play', this.metrics);
    if (
      body.ok !== true ||
      body.playbackRequestId !== command.playbackId ||
      (body.duplicate !== undefined && typeof body.duplicate !== 'boolean') ||
      (body.introPlaybackId !== undefined &&
        body.introPlaybackId !== null &&
        typeof body.introPlaybackId !== 'string') ||
      (command.intro &&
        body.introPlaybackId !== null &&
        body.introPlaybackId !== command.intro.playbackId)
    ) {
      return this.failMalformed('song-play');
    }
    const duplicate = body.duplicate === true;
    this.metrics.recordMachineRequest(
      'song-play',
      duplicate ? 'deduplicated' : 'success',
    );
    return {
      playbackRequestId: command.playbackId,
      duplicate,
      ...(command.intro && {
        introPlaybackId:
          typeof body.introPlaybackId === 'string'
            ? body.introPlaybackId
            : null,
      }),
    };
  }

  async stopSong(palazzoUrl: string, programId: string): Promise<void> {
    await this.okCommand(
      palazzoUrl,
      programId,
      '/playback/song/stop',
      'song-stop',
    );
  }

  async playInstant(
    palazzoUrl: string,
    programId: string,
    command: PalazzoInstantCommand,
  ): Promise<{ playbackRequestId: string }> {
    const response = await this.request(
      palazzoUrl,
      programId,
      '/playback/instant',
      {
        operation: 'instant-play',
        method: 'POST',
        body: {
          programId,
          playbackId: command.playbackId,
          url: command.url,
          volume: command.volume,
        },
      },
    );
    const body = await responseJson(response, 'instant-play', this.metrics);
    if (body.ok !== true || body.playbackRequestId !== command.playbackId) {
      return this.failMalformed('instant-play');
    }
    this.metrics.recordMachineRequest('instant-play', 'success');
    return { playbackRequestId: command.playbackId };
  }

  async stopInstants(palazzoUrl: string, programId: string): Promise<void> {
    await this.okCommand(
      palazzoUrl,
      programId,
      '/playback/instant/stop',
      'instant-stop',
    );
  }

  async updateMixer(
    palazzoUrl: string,
    programId: string,
    mixer: PalazzoMixerState,
  ): Promise<PalazzoMixerState> {
    const response = await this.request(palazzoUrl, programId, '/mixer', {
      operation: 'mixer-update',
      method: 'PUT',
      body: mixer,
      retryable: true,
    });
    const parsed = parsePalazzoMixerState(
      await responseJson(response, 'mixer-update', this.metrics),
    );
    if (!parsed) return this.failMalformed('mixer-update');
    this.metrics.recordMachineRequest('mixer-update', 'success');
    return parsed;
  }

  async getMixer(
    palazzoUrl: string,
    programId: string,
    signal?: AbortSignal,
  ): Promise<PalazzoMixerState> {
    const response = await this.request(palazzoUrl, programId, '/mixer', {
      operation: 'mixer-read',
      signal,
      retryable: true,
    });
    const parsed = parsePalazzoMixerState(
      await responseJson(response, 'mixer-read', this.metrics),
    );
    if (!parsed) return this.failMalformed('mixer-read');
    this.metrics.recordMachineRequest('mixer-read', 'success');
    return parsed;
  }

  async getPlaybackState(
    palazzoUrl: string,
    programId: string,
    signal?: AbortSignal,
  ): Promise<PalazzoPlaybackState> {
    const response = await this.request(
      palazzoUrl,
      programId,
      '/playback/state',
      { operation: 'state-read', signal },
    );
    const parsed = parsePalazzoState(
      await responseJson(response, 'state-read', this.metrics),
    );
    if (!parsed) return this.failMalformed('state-read');
    if (parsed.intro && parsed.intro.programId !== programId) {
      this.metrics.recordMachineRequest('state-read', 'cross-program');
      throw new PalazzoMachineError('cross-program');
    }
    this.metrics.recordMachineRequest('state-read', 'success');
    return parsed;
  }

  async connectEvents(
    palazzoUrl: string,
    programId: string,
    lastEventId: string | null,
    signal: AbortSignal,
  ): Promise<Response> {
    const response = await this.request(
      palazzoUrl,
      programId,
      '/playback/events',
      {
        operation: 'event-connect',
        lastEventId: lastEventId ?? undefined,
        signal,
      },
    );
    if (
      !response.body ||
      !response.headers
        .get('content-type')
        ?.toLowerCase()
        .includes('text/event-stream')
    ) {
      return this.failMalformed('event-connect');
    }
    this.metrics.recordMachineRequest('event-connect', 'success');
    return response;
  }

  private async okCommand(
    palazzoUrl: string,
    programId: string,
    route: string,
    operation: 'song-stop' | 'instant-stop',
  ): Promise<void> {
    const response = await this.request(palazzoUrl, programId, route, {
      operation,
      method: 'POST',
      retryable: true,
    });
    const body = await responseJson(response, operation, this.metrics);
    if (body.ok !== true) this.failMalformed(operation);
    this.metrics.recordMachineRequest(operation, 'success');
  }

  private failMalformed<T>(operation: PalazzoMachineOperation): T {
    this.metrics.recordMachineRequest(operation, 'malformed');
    throw new PalazzoMachineError('malformed');
  }

  private async request(
    palazzoUrl: string,
    programId: string,
    route: string,
    options: RequestOptions,
  ): Promise<Response> {
    let baseUrl: string;
    let boundedProgramId: string;
    try {
      baseUrl = this.validateBaseUrl(palazzoUrl);
      boundedProgramId = validateProgramId(programId);
    } catch {
      this.metrics.recordMachineRequest(options.operation, 'rejected');
      throw new PalazzoMachineError('rejected');
    }
    const url = `${baseUrl}/v1/programs/${encodeURIComponent(boundedProgramId)}${route}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept:
        options.operation === 'event-connect'
          ? 'text/event-stream'
          : 'application/json',
    };
    if (options.body !== undefined)
      headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey)
      headers['Idempotency-Key'] = options.idempotencyKey;
    if (options.lastEventId) headers['Last-Event-ID'] = options.lastEventId;

    const attempts = options.retryable ? MAX_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          method: options.method ?? 'GET',
          headers,
          body:
            options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
          signal: options.signal,
        });
        if (response.ok) return response;
        const result: PalazzoMachineResult =
          response.status === 401 || response.status === 403
            ? 'unauthorized'
            : 'rejected';
        const retry =
          options.retryable &&
          attempt < attempts &&
          (response.status === 429 || response.status >= 500);
        await response.body?.cancel().catch(() => undefined);
        if (!retry) {
          this.metrics.recordMachineRequest(options.operation, result);
          throw new PalazzoMachineError(result, response.status);
        }
      } catch (error) {
        if (error instanceof PalazzoMachineError) throw error;
        if (options.signal?.aborted) throw error;
        if (!options.retryable || attempt >= attempts) {
          this.metrics.recordMachineRequest(options.operation, 'unavailable');
          throw new PalazzoMachineError('unavailable');
        }
      }
      this.metrics.recordMachineRetry(options.operation);
      await delay(100 * 2 ** (attempt - 1), undefined, {
        signal: options.signal,
      }).catch(() => undefined);
    }
    throw new PalazzoMachineError('unavailable');
  }
}

async function responseJson(
  response: Response,
  operation: PalazzoMachineOperation,
  metrics: RadioMetricsService,
): Promise<Record<string, unknown>> {
  try {
    const value = (await response.json()) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    metrics.recordMachineRequest(operation, 'malformed');
    throw new PalazzoMachineError('malformed');
  }
}

function validateProgramId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new PalazzoMachineError('rejected');
  }
  return normalized;
}
