import { Logger, Injectable, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ManagedMetricsService } from './managed-metrics.service';

/** The Fastify request as the metric reads it: the matched route pattern, never the raw URL. */
type MetricRequest = { method: string; routeOptions?: { url?: string } };
type MetricReply = { statusCode: number; elapsedTime: number };

/** A request that matched no route (a 404, or a scanner's path): one fixed label. */
export const UNMATCHED_ROUTE = 'unmatched';

/**
 * The route group of a matched pattern: its first static segment, so `/songs/:id` is `songs`
 * and `/program/:programId/tape` is `program`. A pattern with no static segment, or none at
 * all, is `unmatched`. Only a route pattern is read; the raw URL is never a label.
 */
export function routeGroupOf(request: MetricRequest): string {
  const pattern = request.routeOptions?.url;
  if (!pattern) return UNMATCHED_ROUTE;
  const first = pattern.split('/').filter(Boolean)[0] ?? '';
  if (!first || first.startsWith(':') || first.startsWith('*')) return UNMATCHED_ROUTE;
  return first;
}

/**
 * Records every HTTP response once, in Fastify's onResponse hook. An interceptor saw only requests
 * that reached a handler whose observable emitted, so guard rejections, 404s and streams were
 * missing from the series (gaulatti/alcantara#238). The hook sees every response.
 */
@Injectable()
export class HttpMetricsHook implements OnModuleInit {
  private readonly logger = new Logger('HttpMetricsHook');

  constructor(
    private readonly adapter: HttpAdapterHost,
    private readonly metrics: ManagedMetricsService,
  ) {}

  onModuleInit(): void {
    // A context with no HTTP adapter (a worker, or a test module) serves no requests to count.
    if (!this.adapter.httpAdapter) return;
    const instance = this.adapter.httpAdapter.getInstance() as
      | { addHook?: (name: string, handler: (request: MetricRequest, reply: MetricReply, done: () => void) => void) => void }
      | undefined;
    // Production runs on Fastify. Another adapter (an Express test app) gets no response hook rather
    // than failing start-up: counting requests must never stop the app from starting.
    if (typeof instance?.addHook !== 'function') {
      this.logger.warn('HTTP metrics are off: the HTTP adapter is not Fastify');
      return;
    }
    instance.addHook('onResponse', (request, reply, done) => {
      this.metrics.recordHttp(
        request.method,
        routeGroupOf(request),
        reply.statusCode,
        reply.elapsedTime / 1000,
      );
      done();
    });
  }
}
