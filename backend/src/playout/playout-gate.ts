import type { ManagedMetricsService } from '../observability/managed-metrics.service';
import type { PlayoutLease } from './playout-lease.service';

/** How long a standby holds a request for the lease before refusing it (alcantara#873). */
export const HOLD_LIMIT_MS = 20_000;
/** How many requests a standby holds at once before refusing the next. */
export const MAX_HELD = 200;
/** What a refused request is told to wait before trying again. */
export const RETRY_AFTER_SECONDS = 2;

/**
 * Requests a standby always answers: the deploy's and the candidate's health checks (`GET /`, `/health/*`) and the
 * metrics scrape. Everything else waits for the lease.
 */
export function isNeverHeld(url: string): boolean {
  const path = url.split('?')[0];
  return path === '/' || path === '/metrics' || path.startsWith('/health/');
}

export interface HoldDecision {
  /** Proceed with the request (the instance is active, or became active while it waited). */
  proceed: boolean;
}

/**
 * Holds one request while the instance is a standby: until the lease is taken (then it proceeds), for at most
 * HOLD_LIMIT_MS, and for at most MAX_HELD requests at once. A request that may not proceed is refused by the caller
 * with 503 and Retry-After.
 */
export class PlayoutHold {
  private held = 0;

  constructor(
    private readonly lease: PlayoutLease,
    private readonly metrics: ManagedMetricsService,
    private readonly now: () => number = Date.now,
  ) {}

  async admit(url: string): Promise<HoldDecision> {
    if (this.lease.current === 'active' || isNeverHeld(url))
      return { proceed: true };
    // A standby that is shutting down, or an instance that already let go of the lease, never holds: the request
    // is refused at once, and its retry reaches the instance that takes over (alcantara#873).
    if (this.held >= MAX_HELD || this.lease.shuttingDown) {
      this.metrics.recordPlayoutHold('rejected', 0);
      return { proceed: false };
    }
    this.held += 1;
    const startedAt = this.now();
    try {
      const active = await this.lease.waitUntilActive(HOLD_LIMIT_MS);
      this.metrics.recordPlayoutHold(
        // Let go at shutdown counts as refused, not as a hold that ran out.
        active ? 'served' : this.lease.shuttingDown ? 'rejected' : 'timeout',
        (this.now() - startedAt) / 1000,
      );
      return { proceed: active };
    } finally {
      this.held -= 1;
    }
  }
}

interface GateReply {
  header(name: string, value: string): GateReply;
  code(status: number): GateReply;
  send(body: unknown): unknown;
}

/** Installs the hold on every HTTP request of a standby (never on a deploy candidate, which serves read-only). */
export function installPlayoutGate(
  fastify: {
    addHook(
      name: 'onRequest',
      hook: (request: { url: string }, reply: GateReply) => Promise<unknown>,
    ): unknown;
  },
  hold: PlayoutHold,
): void {
  fastify.addHook('onRequest', async (request, reply) => {
    const decision = await hold.admit(request.url);
    if (decision.proceed) return undefined;
    return reply
      .header('Retry-After', String(RETRY_AFTER_SECONDS))
      .code(503)
      .send({
        statusCode: 503,
        message: 'This backend is taking over; try again shortly.',
      });
  });
}

type UpgradeListener = (
  request: { url?: string },
  socket: { write(data: string): unknown; destroy(): void },
  head: Buffer,
) => void;
interface UpgradeServer {
  on(event: 'upgrade', listener: UpgradeListener): unknown;
  off(event: 'upgrade', listener: UpgradeListener): unknown;
}

/**
 * The HTTP server as the realtime service sees it, with every WebSocket upgrade passed through the standby hold.
 * Upgrades are attached after listen, outside Nest, so the request hook does not see them.
 */
export function gateUpgrades<S extends UpgradeServer>(
  server: S,
  hold: PlayoutHold,
): S {
  const wrapped = new Map<UpgradeListener, UpgradeListener>();
  const facade = Object.create(server) as S;
  facade.on = ((event: 'upgrade', listener: UpgradeListener) => {
    const gated: UpgradeListener = (request, socket, head) => {
      void hold.admit(request.url ?? '').then((decision) => {
        if (decision.proceed) {
          listener(request, socket, head);
          return;
        }
        socket.write(
          `HTTP/1.1 503 Service Unavailable\r\nRetry-After: ${RETRY_AFTER_SECONDS}\r\nConnection: close\r\n\r\n`,
        );
        socket.destroy();
      });
    };
    wrapped.set(listener, gated);
    return server.on(event, gated);
  }) as S['on'];
  facade.off = ((event: 'upgrade', listener: UpgradeListener) => {
    const gated = wrapped.get(listener) ?? listener;
    wrapped.delete(listener);
    return server.off(event, gated);
  }) as S['off'];
  return facade;
}
