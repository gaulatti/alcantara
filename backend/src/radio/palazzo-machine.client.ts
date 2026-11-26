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
import { normalizePalazzoBaseUrl } from '../config/runtime-secrets';

/**
 * Palazzo's filler statuses that mean "not ready" (palazzo
 * src/stream/filler-store.service.ts). With `ready: true` they contradict the
 * answer, so they stay malformed; any other unknown status is tolerated.
 */
const FILLER_NOT_READY_STATUSES: ReadonlySet<string> = new Set([
  'unprepared',
  'preparing',
  'failed',
]);

/**
 * How long one Palazzo command may go unanswered before it counts as unavailable (gaulatti/alcantara#717). Without
 * it a frozen engine (connections accepted, no answers) held every command until it answered: an operator's stop
 * hung about 31 s in the engine-outage walk. The event stream is long-lived and output-monitor has its own timeout,
 * so neither uses this one.
 */
export const PALAZZO_COMMAND_TIMEOUT_MS = 10_000;
const UNTIMED_OPERATIONS: ReadonlySet<string> = new Set([
  'event-connect',
  'output-monitor',
]);

export class PalazzoMachineError extends Error {
  constructor(
    readonly reason: PalazzoMachineResult,
    readonly status?: number,
  ) {
    super(reason);
  }
}

export interface PalazzoSongSegue {
  cueInSeconds: number;
  cueOutSeconds: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  overlapSeconds: number;
}

export interface PalazzoSongLoudness {
  integratedLufs: number;
  truePeakDbtp: number;
}

export interface PalazzoSongCommand {
  playbackId: string;
  url: string;
  title?: string;
  artist?: string;
  coverUrl?: string;
  intro?: PalazzoIntroCommand;
  duration?: number;
  segue?: PalazzoSongSegue;
  loudness?: PalazzoSongLoudness;
}

/** The next song announced while the current one plays (contract palazzo#40 §1): a song command without an intro. */
export type PalazzoNextSongCommand = Omit<PalazzoSongCommand, 'intro'> & {
  /**
   * A spot Palazzo plays when the current song ends, before this one, which
   * starts at the spot's own end (gaulatti/palazzo#50). Sent only to a
   * Palazzo that lists the `next.bumper` capability.
   */
  bumper?: { playbackId: string; url: string };
};

/**
 * What Palazzo answered to an announcement: `accepted` (200, queued),
 * `not_ready` (422, nothing queued), `rejected` (409 nothing playing, or 400
 * invalid: not announced) or `unsupported` (404, an older Palazzo).
 */
export type PalazzoNextAnnouncementResult =
  | { result: 'accepted'; duplicate: boolean }
  | { result: 'not_ready' }
  | { result: 'rejected' }
  | { result: 'unsupported' };

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
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  commandSequence?: number;
  fillerVersion?: string;
  lastEventId?: string;
  signal?: AbortSignal;
  retryable?: boolean;
}

const MAX_ATTEMPTS = 3;
export const PALAZZO_FETCH = 'PALAZZO_FETCH';

/**
 * Sole transport boundary for Palazzo's private, program-scoped API.
 * Browser code never receives direct access to this client.
 */
@Injectable()
export class PalazzoMachineClient {
  private readonly allowedUrls: ReadonlySet<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(
    config: ConfigService,
    private readonly metrics: RadioMetricsService,
    @Optional() @Inject(PALAZZO_FETCH) fetchImpl?: typeof fetch,
  ) {
    const nodeEnvironment = config.get<string>('NODE_ENV') ?? 'development';
    const configuredUrls =
      config.get<string>('PALAZZO_ALLOWED_URLS')?.trim() ||
      (nodeEnvironment === 'test' ? 'http://palazzo:3100' : '');
    const allowedUrls = configuredUrls
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map(normalizePalazzoBaseUrl);
    if (!allowedUrls.length) {
      throw new Error('PALAZZO_ALLOWED_URLS must contain an approved URL');
    }
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
    try {
      if (command.segue !== undefined) {
        validateSongSegue(command.segue, command.duration);
      }
      if (command.loudness !== undefined) {
        validateSongLoudness(command.loudness);
      }
    } catch {
      this.metrics.recordMachineRequest('song-play', 'rejected');
      throw new PalazzoMachineError('rejected');
    }

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
            ...(command.segue && { segue: command.segue }),
            ...(command.loudness && { loudness: command.loudness }),
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

  /**
   * Announces the next song (`PUT …/playback/next`). Maps every status the
   * contract defines; any other failure is thrown as for the song command.
   */
  async announceNext(
    palazzoUrl: string,
    programId: string,
    command: PalazzoNextSongCommand,
  ): Promise<PalazzoNextAnnouncementResult> {
    try {
      if (command.segue !== undefined) {
        validateSongSegue(command.segue, command.duration);
      }
      if (command.loudness !== undefined) {
        validateSongLoudness(command.loudness);
      }
    } catch {
      this.metrics.recordMachineRequest('next-announce', 'rejected');
      throw new PalazzoMachineError('rejected');
    }

    let response: Response;
    try {
      response = await this.request(palazzoUrl, programId, '/playback/next', {
        operation: 'next-announce',
        method: 'PUT',
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
            ...(command.segue && { segue: command.segue }),
            ...(command.loudness && { loudness: command.loudness }),
          },
          ...(command.bumper && {
            bumper: {
              playbackId: command.bumper.playbackId,
              url: command.bumper.url,
            },
          }),
        },
      });
    } catch (error) {
      if (error instanceof PalazzoMachineError) {
        if (error.status === 404) return { result: 'unsupported' };
        if (error.status === 422) return { result: 'not_ready' };
        if (error.status === 409 || error.status === 400) {
          return { result: 'rejected' };
        }
      }
      throw error;
    }
    const body = await responseJson(response, 'next-announce', this.metrics);
    if (
      body.ok !== true ||
      body.playbackRequestId !== command.playbackId ||
      typeof body.state !== 'string' ||
      !body.state ||
      (body.duplicate !== undefined && typeof body.duplicate !== 'boolean')
    ) {
      return this.failMalformed('next-announce');
    }
    if (body.state !== 'queued') {
      // A state Alcantara does not know is not a confirmed announcement: it is
      // read as rejected (the song is not announced), not as a malformed
      // answer (gaulatti/ariston#217). The playbackRequestId echo stays strict.
      this.metrics.recordMachineRequest('next-announce', 'unknown-value');
      return { result: 'rejected' };
    }
    const duplicate = body.duplicate === true;
    this.metrics.recordMachineRequest(
      'next-announce',
      duplicate ? 'deduplicated' : 'success',
    );
    return { result: 'accepted', duplicate };
  }

  /** Withdraws the announced next song (`DELETE …/playback/next`). */
  async withdrawNext(
    palazzoUrl: string,
    programId: string,
  ): Promise<{ withdrawn: boolean }> {
    const response = await this.request(
      palazzoUrl,
      programId,
      '/playback/next',
      { operation: 'next-withdraw', method: 'DELETE', retryable: true },
    );
    const body = await responseJson(response, 'next-withdraw', this.metrics);
    if (body.ok !== true || typeof body.withdrawn !== 'boolean') {
      return this.failMalformed('next-withdraw');
    }
    this.metrics.recordMachineRequest('next-withdraw', 'success');
    return { withdrawn: body.withdrawn };
  }

  async stopSong(palazzoUrl: string, programId: string): Promise<void> {
    await this.okCommand(
      palazzoUrl,
      programId,
      '/playback/song/stop',
      'song-stop',
    );
  }

  async openOutput(
    palazzoUrl: string,
    programId: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 10_000);
    let response: Response;
    try {
      response = await this.request(palazzoUrl, programId, '/output/audio', {
        operation: 'output-monitor',
        signal: AbortSignal.any([signal, timeout.signal]),
      });
    } catch (error) {
      if (timeout.signal.aborted && !signal.aborted) {
        this.metrics.recordMachineRequest('output-monitor', 'unavailable');
      }
      throw error;
    } finally {
      // Bound connection establishment, not the lifetime of live audio.
      clearTimeout(timer);
    }
    if (
      !response.body ||
      !response.headers.get('content-type')?.startsWith('audio/')
    ) {
      await response.body?.cancel();
      return this.failMalformed('output-monitor');
    }
    this.metrics.recordMachineRequest('output-monitor', 'success');
    return response;
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

  /**
   * Reads the authenticated playback state. `previousStatus` is the status to
   * keep if Palazzo reports one Alcantara does not know (gaulatti/ariston#217).
   */
  async getPlaybackState(
    palazzoUrl: string,
    programId: string,
    signal?: AbortSignal,
    previousStatus?: PalazzoPlaybackState['status'],
  ): Promise<PalazzoPlaybackState> {
    const response = await this.request(
      palazzoUrl,
      programId,
      '/playback/state',
      { operation: 'state-read', signal },
    );
    const parsed = parsePalazzoState(
      await responseJson(response, 'state-read', this.metrics),
      {
        previousStatus,
        onUnknown: (field) => this.metrics.recordUnknownValue(field),
      },
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

  async getAutomation(
    palazzoUrl: string,
    programId: string,
  ): Promise<{
    lastSequence: number;
    requestedState: string;
    actualState: string;
    filler: { activeVersion: string | null; ready: boolean };
  }> {
    const response = await this.request(palazzoUrl, programId, '/automation', {
      operation: 'automation-read',
    });
    const body = await responseJson(response, 'automation-read', this.metrics);
    if (
      !Number.isInteger(body.lastSequence) ||
      typeof body.requestedState !== 'string' ||
      typeof body.actualState !== 'string' ||
      !body.filler ||
      typeof body.filler !== 'object'
    )
      return this.failMalformed('automation-read');
    const filler = body.filler as Record<string, unknown>;
    if (
      (filler.activeVersion !== null &&
        typeof filler.activeVersion !== 'string') ||
      typeof filler.ready !== 'boolean'
    )
      return this.failMalformed('automation-read');
    this.metrics.recordMachineRequest('automation-read', 'success');
    return {
      lastSequence: body.lastSequence as number,
      requestedState: body.requestedState,
      actualState: body.actualState,
      filler: {
        activeVersion: filler.activeVersion as string | null,
        ready: filler.ready,
      },
    };
  }

  async prepareFiller(
    palazzoUrl: string,
    programId: string,
    version: string,
    assets: Array<{ id: string; sha256: string; downloadUrl: string }>,
    order: { mode: 'ordered' } | { mode: 'shuffle'; shuffleSeed: string } = {
      mode: 'ordered',
    },
  ): Promise<void> {
    const response = await this.request(
      palazzoUrl,
      programId,
      `/fillers/${encodeURIComponent(version)}`,
      {
        operation: 'filler-prepare',
        method: 'PUT',
        idempotencyKey: version,
        retryable: true,
        body: { commandId: version, ...order, assets },
      },
    );
    const body = await responseJson(response, 'filler-prepare', this.metrics);
    if (
      body.version !== version ||
      body.ready !== true ||
      typeof body.status !== 'string' ||
      !body.status ||
      FILLER_NOT_READY_STATUSES.has(body.status)
    )
      return this.failMalformed('filler-prepare');
    // `ready: true` with the exact version echo is the readiness Alcantara
    // binds to. A `status` other than `ready` is a value Alcantara does not
    // know; it is counted, not a failed preparation (gaulatti/ariston#217).
    this.metrics.recordMachineRequest(
      'filler-prepare',
      body.status === 'ready' ? 'success' : 'unknown-value',
    );
  }

  async commandAutomation(
    palazzoUrl: string,
    programId: string,
    action: 'start' | 'stop',
    sequence: number,
    key: string,
    fillerVersion?: string,
  ): Promise<void> {
    const operation =
      action === 'start' ? 'automation-start' : 'automation-stop';
    const response = await this.request(
      palazzoUrl,
      programId,
      `/automation/${action}`,
      {
        operation,
        method: 'POST',
        idempotencyKey: key,
        commandSequence: sequence,
        fillerVersion,
        retryable: true,
      },
    );
    const body = await responseJson(response, operation, this.metrics);
    if (
      body.lastSequence !== sequence ||
      (action === 'start' &&
        (body.readiness !== true ||
          (body.filler as Record<string, unknown> | undefined)
            ?.activeVersion !== fillerVersion))
    )
      return this.failMalformed(operation);
    this.metrics.recordMachineRequest(operation, 'success');
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
      Accept:
        options.operation === 'event-connect'
          ? 'text/event-stream'
          : options.operation === 'output-monitor'
            ? 'audio/*'
            : 'application/json',
    };
    if (options.body !== undefined)
      headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey)
      headers['Idempotency-Key'] = options.idempotencyKey;
    if (options.commandSequence)
      headers['X-Command-Sequence'] = String(options.commandSequence);
    if (options.fillerVersion)
      headers['X-Filler-Version'] = options.fillerVersion;
    if (options.lastEventId) headers['Last-Event-ID'] = options.lastEventId;

    const attempts = options.retryable ? MAX_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      // Each attempt is bounded; a caller's own signal still cancels it (and is rethrown below).
      const timeout = UNTIMED_OPERATIONS.has(options.operation)
        ? undefined
        : AbortSignal.timeout(PALAZZO_COMMAND_TIMEOUT_MS);
      const signal =
        timeout && options.signal
          ? AbortSignal.any([options.signal, timeout])
          : (timeout ?? options.signal);
      try {
        const response = await this.fetchImpl(url, {
          method: options.method ?? 'GET',
          headers,
          body:
            options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
          signal,
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

export function validateSongSegue(
  segue: unknown,
  duration?: number,
): asserts segue is PalazzoSongSegue {
  if (!segue || typeof segue !== 'object') {
    throw new PalazzoMachineError('rejected');
  }
  const s = segue as Record<string, unknown>;
  const {
    cueInSeconds,
    cueOutSeconds,
    fadeInSeconds,
    fadeOutSeconds,
    overlapSeconds,
  } = s;

  if (
    typeof cueInSeconds !== 'number' ||
    !Number.isFinite(cueInSeconds) ||
    typeof cueOutSeconds !== 'number' ||
    !Number.isFinite(cueOutSeconds) ||
    typeof fadeInSeconds !== 'number' ||
    !Number.isFinite(fadeInSeconds) ||
    typeof fadeOutSeconds !== 'number' ||
    !Number.isFinite(fadeOutSeconds) ||
    typeof overlapSeconds !== 'number' ||
    !Number.isFinite(overlapSeconds)
  ) {
    throw new PalazzoMachineError('rejected');
  }

  if (cueInSeconds < 0 || cueInSeconds >= cueOutSeconds) {
    throw new PalazzoMachineError('rejected');
  }

  if (
    duration !== undefined &&
    (!Number.isFinite(duration) || cueOutSeconds > duration)
  ) {
    throw new PalazzoMachineError('rejected');
  }

  if (fadeInSeconds < 0 || fadeOutSeconds < 0) {
    throw new PalazzoMachineError('rejected');
  }

  if (overlapSeconds < 0 || overlapSeconds > cueOutSeconds - cueInSeconds) {
    throw new PalazzoMachineError('rejected');
  }
}

export function validateSongLoudness(
  loudness: unknown,
): asserts loudness is PalazzoSongLoudness {
  if (!loudness || typeof loudness !== 'object') {
    throw new PalazzoMachineError('rejected');
  }
  const l = loudness as Record<string, unknown>;
  const { integratedLufs, truePeakDbtp } = l;

  if (
    typeof integratedLufs !== 'number' ||
    !Number.isFinite(integratedLufs) ||
    typeof truePeakDbtp !== 'number' ||
    !Number.isFinite(truePeakDbtp)
  ) {
    throw new PalazzoMachineError('rejected');
  }

  if (integratedLufs < -70 || integratedLufs > 0) {
    throw new PalazzoMachineError('rejected');
  }

  if (truePeakDbtp > 6) {
    throw new PalazzoMachineError('rejected');
  }
}
