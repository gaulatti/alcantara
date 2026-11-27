import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { createRequire } from 'node:module';
import { isDeployCandidate } from '../config/deploy-candidate';
import { ManagedMetricsService } from '../observability/managed-metrics.service';

/** The advisory lock key of the playout lease (alcantara#873). One per database, so one engine per database. */
export const PLAYOUT_LEASE_KEY = 873_001;
/** How often a standby asks for the lock. */
export const LEASE_ATTEMPT_MS = 1_000;
/** How often the holder proves its lock connection is alive; a failed proof ends the process. */
export const LEASE_LIVENESS_MS = 2_000;

export type PlayoutState = 'standby' | 'active';
/** Overrides of the production defaults, for tests; nothing provides it in the application. */
export const PLAYOUT_LEASE_OPTIONS = 'PLAYOUT_LEASE_OPTIONS';

export interface LeaseConnection {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
  on(event: 'error' | 'end', listener: (...args: unknown[]) => void): unknown;
}

type PgClient = LeaseConnection & { connect(): Promise<void> };
type PgClientConstructor = new (config: {
  connectionString?: string;
  application_name: string;
  keepAlive: boolean;
}) => PgClient;

/** `pg` ships without type definitions here; only the calls the lease makes are typed. */
function pgClient(): PgClientConstructor {
  return (createRequire(__filename)('pg') as { Client: PgClientConstructor })
    .Client;
}

export interface PlayoutLeaseOptions {
  /** Take the database lock (production). Off: the instance is active from the start (local, CI, tests). */
  lock: boolean;
  /** A deploy candidate: a permanent standby that never asks for the lock. */
  candidate: boolean;
  connect: () => Promise<LeaseConnection>;
  /** Ends the process when the lock may have been lost: an instance that cannot prove it holds the lock must stop. */
  exit: (code: number) => void;
}

/** The production defaults; exported for the tests. */
export function defaultPlayoutLeaseOptions(): PlayoutLeaseOptions {
  return {
    lock: process.env.NODE_ENV === 'production',
    candidate: isDeployCandidate(),
    connect: async () => {
      // Its own connection, never a pooled one: the lock lives and dies with this session.
      const Client = pgClient();
      const client = new Client({
        connectionString: process.env.DATABASE_URL,
        application_name: 'alcantara-playout-lease',
        keepAlive: true,
      });
      await client.connect();
      return client;
    },
    exit: (code) => process.exit(code),
  };
}

/**
 * The playout lease (alcantara#873): exactly one backend instance drives playout and runs the writers and schedulers.
 * It holds a PostgreSQL advisory lock on a connection of its own; PostgreSQL frees the lock if the process or that
 * connection dies. Every writer and scheduler starts through `whenActive`. Until the lock is held the instance is a
 * standby: it boots, listens and answers health checks, and its other requests wait (see `playout-gate.ts`).
 *
 * Without the lock mode (local, CI, tests) the instance is active from the start, so a single instance behaves exactly
 * as before. A deploy candidate is a permanent standby. If the lock connection fails the process exits: an instance
 * that may have lost the lock must not command Palazzo, and a restarted one waits for the lock again.
 */
@Injectable()
export class PlayoutLease implements OnModuleDestroy {
  private readonly logger = new Logger(PlayoutLease.name);
  private readonly options: PlayoutLeaseOptions;
  private state: PlayoutState;
  private readonly pending: Array<() => unknown> = [];
  private readonly waiters = new Set<() => void>();
  private connection: LeaseConnection | null = null;
  private attemptTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private started = false;
  private stopping = false;

  constructor(
    private readonly metrics: ManagedMetricsService,
    @Optional()
    @Inject(PLAYOUT_LEASE_OPTIONS)
    options?: Partial<PlayoutLeaseOptions>,
  ) {
    this.options = { ...defaultPlayoutLeaseOptions(), ...options };
    this.state =
      this.options.lock || this.options.candidate ? 'standby' : 'active';
    this.metrics.setPlayoutLeaseState(this.state);
  }

  get current(): PlayoutState {
    return this.state;
  }

  /**
   * Runs `start` once this instance holds the lease. When it already does, `start` runs now and its promise is
   * returned, so a caller's start-up hook awaits it exactly as before; otherwise it runs at activation.
   */
  whenActive(start: () => unknown): Promise<void> | undefined {
    if (this.state === 'active') return this.run(start);
    this.pending.push(start);
    return undefined;
  }

  /** Resolves when the instance becomes active, or false after `timeoutMs`. */
  waitUntilActive(timeoutMs: number): Promise<boolean> {
    if (this.state === 'active') return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(done);
        resolve(false);
      }, timeoutMs);
      this.waiters.add(done);
    });
  }

  /** Starts asking for the lock (lock mode only). Called once the application listens. */
  start(): void {
    if (this.started || !this.options.lock || this.options.candidate) return;
    this.started = true;
    void this.attempt();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.attemptTimer) clearTimeout(this.attemptTimer);
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.attemptTimer = null;
    this.livenessTimer = null;
    const connection = this.connection;
    this.connection = null;
    // Closing the session frees the lock for the next instance at once.
    await connection?.end().catch(() => undefined);
  }

  private async attempt(): Promise<void> {
    if (this.stopping) return;
    try {
      this.connection ??= await this.openConnection();
      const result = await this.connection.query(
        'SELECT pg_try_advisory_lock($1) AS held',
        [PLAYOUT_LEASE_KEY],
      );
      if (result.rows[0]?.held === true) {
        await this.activate();
        return;
      }
    } catch (error) {
      this.logger.warn(
        `Playout lease not taken: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      const connection = this.connection;
      this.connection = null;
      await connection?.end().catch(() => undefined);
    }
    if (!this.stopping)
      this.attemptTimer = setTimeout(
        () => void this.attempt(),
        LEASE_ATTEMPT_MS,
      );
  }

  private async openConnection(): Promise<LeaseConnection> {
    const connection = await this.options.connect();
    connection.on('error', () => this.lost('error'));
    connection.on('end', () => this.lost('end'));
    return connection;
  }

  private lost(reason: string): void {
    if (this.stopping || this.state !== 'active') return;
    this.metrics.recordPlayoutLeaseLost();
    this.logger.error(
      `Playout lease connection lost (${reason}): stopping so no second engine can run`,
    );
    this.options.exit(1);
  }

  private async activate(): Promise<void> {
    const startedAt = Date.now();
    this.livenessTimer = setInterval(() => {
      void this.connection
        ?.query('SELECT 1')
        .catch(() => this.lost('liveness'));
    }, LEASE_LIVENESS_MS);
    this.livenessTimer.unref?.();
    for (const start of this.pending.splice(0)) await this.run(start);
    this.state = 'active';
    this.metrics.setPlayoutLeaseState('active');
    this.metrics.recordPlayoutActivation((Date.now() - startedAt) / 1000);
    this.logger.log('Playout lease held: this instance drives playout');
    for (const waiter of [...this.waiters]) waiter();
  }

  private async run(start: () => unknown): Promise<void> {
    try {
      await start();
    } catch (error) {
      this.logger.error(
        `A playout start-up step failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}

/**
 * Starts a writer or scheduler through the lease. Where no lease is wired (unit tests), or the instance is already
 * active, `start` runs now and its result is returned for the start-up hook to await, exactly as before the lease.
 */
export function startWhenActive<T>(
  lease: PlayoutLease | null | undefined,
  start: () => T,
): T | Promise<void> | undefined {
  if (!lease) return start();
  return lease.whenActive(start);
}
