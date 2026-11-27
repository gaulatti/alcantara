import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PlayoutModule } from './playout.module';
import {
  LEASE_ATTEMPT_MS,
  LEASE_UNLOCK_MS,
  PLAYOUT_LEASE_KEY,
  PLAYOUT_LEASE_OPTIONS,
  PlayoutLease,
  type LeaseConnection,
} from './playout-lease.service';

// alcantara#873: at shutdown the old instance stops every writer and scheduler, then frees the playout lock, and only
// then closes its HTTP server, so the standby takes over on its next ask (every LEASE_ATTEMPT_MS).

const UNLOCK = 'SELECT pg_advisory_unlock($1)';

function connection(log: string[], held: boolean[] = [true]) {
  const flags = { hangUnlock: false };
  const queryMock = jest.fn((sql: string, values?: unknown[]) => {
    if (sql === UNLOCK) {
      log.push(`unlock ${String(values?.[0])}`);
      return flags.hangUnlock
        ? new Promise<never>(() => undefined)
        : Promise.resolve({ rows: [{}] });
    }
    if (sql === 'SELECT 1') return Promise.resolve({ rows: [{}] });
    return Promise.resolve({
      rows: [{ held: held.length > 1 ? held.shift() : held[0] }],
    });
  });
  const fake: LeaseConnection & {
    flags: typeof flags;
    query: typeof queryMock;
  } = {
    flags,
    query: queryMock,
    end: jest.fn(() => {
      log.push('end');
      return Promise.resolve();
    }),
    on: jest.fn(),
  };
  return fake;
}

const metric = async (metrics: ManagedMetricsService, line: string) =>
  (await metrics.render('')).split('\n').find((l) => l.startsWith(line));

describe('PlayoutLease at shutdown', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('asks every 200 ms while standing by', () => {
    expect(LEASE_ATTEMPT_MS).toBe(200);
  });

  it('keeps the lock through the destroy phase, then reports standby and frees it before closing the connection', async () => {
    const log: string[] = [];
    const metrics = new ManagedMetricsService();
    const conn = connection(log);
    const lease = new PlayoutLease(metrics, {
      lock: true,
      candidate: false,
      connect: () => Promise.resolve(conn),
      exit: jest.fn(),
    });
    lease.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(lease.current).toBe('active');

    lease.onModuleDestroy();
    expect(lease.current).toBe('active');
    expect(log).toEqual([]);

    conn.query.mockImplementationOnce((sql: string) => {
      // The state turns standby before the unlock is sent: the engine sends nothing from then on.
      log.push(`${sql} while ${lease.current}`);
      return Promise.resolve({ rows: [{}] });
    });
    await lease.beforeApplicationShutdown();
    expect(log).toEqual([`${UNLOCK} while standby`, 'end']);
    expect(conn.query).toHaveBeenLastCalledWith(UNLOCK, [PLAYOUT_LEASE_KEY]);
    expect(
      await metric(metrics, 'alcantara_playout_lease{state="active"}'),
    ).toMatch(/ 0$/);
    // Nothing more is asked afterwards.
    await jest.advanceTimersByTimeAsync(LEASE_ATTEMPT_MS * 5);
    expect(conn.query).toHaveBeenCalledTimes(2);
  });

  it('closes the connection anyway when the unlock does not answer', async () => {
    const log: string[] = [];
    const conn = connection(log);
    conn.flags.hangUnlock = true;
    const lease = new PlayoutLease(new ManagedMetricsService(), {
      lock: true,
      candidate: false,
      connect: () => Promise.resolve(conn),
      exit: jest.fn(),
    });
    lease.start();
    await jest.advanceTimersByTimeAsync(0);
    const closing = lease.beforeApplicationShutdown();
    await jest.advanceTimersByTimeAsync(LEASE_UNLOCK_MS - 1);
    expect(log).toEqual([`unlock ${PLAYOUT_LEASE_KEY}`]);
    await jest.advanceTimersByTimeAsync(1);
    await closing;
    expect(log).toEqual([`unlock ${PLAYOUT_LEASE_KEY}`, 'end']);
  });

  it('gives back a lock taken during shutdown, and starts nothing', async () => {
    const log: string[] = [];
    let grant: (value: { rows: Array<Record<string, unknown>> }) => void = () =>
      undefined;
    const conn = connection(log);
    conn.query.mockImplementationOnce(
      () => new Promise((resolve) => (grant = resolve)),
    );
    const lease = new PlayoutLease(new ManagedMetricsService(), {
      lock: true,
      candidate: false,
      connect: () => Promise.resolve(conn),
      exit: jest.fn(),
    });
    const started = jest.fn();
    void lease.whenActive(started);
    lease.start();
    await jest.advanceTimersByTimeAsync(0);
    lease.onModuleDestroy();
    grant({ rows: [{ held: true }] });
    await jest.advanceTimersByTimeAsync(0);
    expect(log).toEqual([`unlock ${PLAYOUT_LEASE_KEY}`]);
    expect(started).not.toHaveBeenCalled();
    expect(lease.current).toBe('standby');
    await lease.beforeApplicationShutdown();
    expect(log).toEqual([`unlock ${PLAYOUT_LEASE_KEY}`, 'end']);
  });

  it('only closes the connection of a standby, and has nothing to free without the lock mode', async () => {
    const log: string[] = [];
    const conn = connection(log, [false]);
    const standby = new PlayoutLease(new ManagedMetricsService(), {
      lock: true,
      candidate: false,
      connect: () => Promise.resolve(conn),
      exit: jest.fn(),
    });
    standby.start();
    await jest.advanceTimersByTimeAsync(0);
    await standby.beforeApplicationShutdown();
    expect(log).toEqual(['end']);

    const local = new PlayoutLease(new ManagedMetricsService(), {
      lock: false,
      candidate: false,
    });
    await local.beforeApplicationShutdown();
    expect(local.current).toBe('active');
  });
});

// The real Nest shutdown: the engine and the schedulers live in global modules, like the lease, so Nest's module order
// alone does not put them first. Whatever order the modules are registered in, the lock is freed only after every
// writer stopped.
describe('PlayoutLease in a Nest application shutdown', () => {
  async function shutDown(engineFirst: boolean) {
    const log: string[] = [];
    const conn = connection(log);

    @Injectable()
    class Engine implements OnModuleDestroy {
      async onModuleDestroy() {
        await new Promise((resolve) => setImmediate(resolve));
        log.push('engine stopped');
      }
    }
    @Global()
    @Module({ providers: [Engine], exports: [Engine] })
    class EngineModule {}
    @Global()
    @Module({
      providers: [
        ManagedMetricsService,
        {
          provide: PLAYOUT_LEASE_OPTIONS,
          useValue: {
            lock: true,
            candidate: false,
            connect: () => Promise.resolve(conn),
            exit: jest.fn(),
          },
        },
      ],
      exports: [ManagedMetricsService, PLAYOUT_LEASE_OPTIONS],
    })
    class PlatformModule {}

    const app = await Test.createTestingModule({
      imports: engineFirst
        ? [PlatformModule, EngineModule, PlayoutModule]
        : [PlatformModule, PlayoutModule, EngineModule],
    }).compile();
    await app.init();
    const lease = app.get(PlayoutLease);
    lease.start();
    await expect(lease.waitUntilActive(1_000)).resolves.toBe(true);
    await app.close();
    return log;
  }

  it.each([
    ['before', true],
    ['after', false],
  ])(
    'stops the engine registered %s the lease, then frees the lock, then closes',
    async (_name, engineFirst) => {
      expect(await shutDown(engineFirst)).toEqual([
        'engine stopped',
        `unlock ${PLAYOUT_LEASE_KEY}`,
        'end',
      ]);
    },
  );
});
