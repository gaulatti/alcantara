import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PALAZZO_FETCH } from '../radio/palazzo-machine.client';
import { normalizePalazzoBaseUrl } from '../config/runtime-secrets';
import { ManagedMetricsService } from './managed-metrics.service';

/** Total budget for connecting, answering and reading the body. */
export const PALAZZO_METRICS_TIMEOUT_MS = 2000;
/** Largest Palazzo exposition accepted, in bytes. */
export const PALAZZO_METRICS_MAX_BYTES = 5 * 1024 * 1024;

class TooLarge extends Error {}

/**
 * Fetches Palazzo's Prometheus text from the one configured private origin.
 * The destination is fixed, redirects are refused, and no credential is sent.
 */
@Injectable()
export class PalazzoMetricsPassthrough {
  private readonly logger = new Logger(PalazzoMetricsPassthrough.name);
  private warnedUnconfigured = false;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: ConfigService,
    private readonly metrics: ManagedMetricsService,
    @Optional() @Inject(PALAZZO_FETCH) fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl =
      fetchImpl ??
      ((
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => globalThis.fetch(input, init));
  }

  /** The Palazzo body, or null when it must be answered as 502 empty. */
  async fetch(): Promise<string | null> {
    const started = process.hrtime.bigint();
    const base = this.baseUrl();
    if (base === null) return this.finish('unavailable', started, null);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, PALAZZO_METRICS_TIMEOUT_MS);
    const done = (result: string, body: string | null): string | null => {
      clearTimeout(timer);
      return this.finish(result, started, body);
    };
    let reachedPalazzo = false;
    try {
      const response = await this.fetchImpl(`${base}/metrics`, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'text/plain' },
      });
      reachedPalazzo = true;
      if (response.status < 200 || response.status > 299) {
        void response.body?.cancel().catch(() => undefined);
        return done('error', null);
      }
      return done('ok', await this.readCapped(response, controller));
    } catch (error) {
      if (timedOut) return done('timeout', null);
      if (error instanceof TooLarge) return done('too_large', null);
      return done(reachedPalazzo ? 'error' : 'unavailable', null);
    }
  }

  private finish(
    result: string,
    started: bigint,
    body: string | null,
  ): string | null {
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    this.metrics.recordPalazzoMetricsScrape(result, seconds);
    return body;
  }

  private baseUrl(): string | null {
    const entries = (this.config.get<string>('PALAZZO_ALLOWED_URLS') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    try {
      if (entries.length === 1) return normalizePalazzoBaseUrl(entries[0]);
    } catch {
      // Fall through to the single fail-closed warning below.
    }
    if (!this.warnedUnconfigured) {
      this.warnedUnconfigured = true;
      this.logger.warn(
        'Palazzo metrics passthrough unavailable: PALAZZO_ALLOWED_URLS does not name exactly one valid Palazzo origin',
      );
    }
    return null;
  }

  private async readCapped(
    response: Response,
    controller: AbortController,
  ): Promise<string> {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > PALAZZO_METRICS_MAX_BYTES) {
      controller.abort();
      throw new TooLarge();
    }
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > PALAZZO_METRICS_MAX_BYTES) {
        controller.abort();
        throw new TooLarge();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}
