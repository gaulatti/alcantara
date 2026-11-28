import { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  LEASE_ATTEMPT_MS,
  LEASE_LIVENESS_MS,
  PLAYOUT_LEASE_KEY,
  PlayoutLease,
  startWhenActive,
  defaultPlayoutLeaseOptions,
  type LeaseConnection,
} from './playout-lease.service';

// The playout lease (alcantara#873): one instance drives playout; the others stand by until the lock is free.

function connection(held: boolean[] = [true]) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  let liveness = true;
  const fake: LeaseConnection & {
    queries: typeof queries;
    emit: (event: string) => void;
    failLiveness: () => void;
    ended: boolean;
  } = {
    queries,
    ended: false,
    query: jest.fn(async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql === 'SELECT 1') {
        if (!liveness) throw new Error('gone');
        return { rows: [{}] };
      }
      return { rows: [{ held: held.length > 1 ? held.shift() : held[0] }] };
    }),
    end: jest.fn(async () => {
      fake.ended = true;
    }),
    on: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
      return fake;
    }),
    emit: (event: string) => listeners.get(event)?.(),
    failLiveness: () => {
      liveness = false;
    },
  };
  return fake;
}

const metric = async (metrics: ManagedMetricsService, line: string) =>
  (await metrics.render('')).split('\n').find((l) => l.startsWith(line));

describe('PlayoutLease', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('is active from the start without the lock mode, and runs start-up steps at once, awaitable', async () => {
    const metrics = new ManagedMetricsService();
    const lease = new PlayoutLease(metrics, { lock: false, candidate: false });
    expect(lease.current).toBe('active');
    const order: string[] = [];
    await lease.whenActive(async () => {
      order.push('engine');
    });
    expect(order).toEqual(['engine']);
    lease.start();
    await expect(lease.waitUntilActive(10)).resolves.toBe(true);
    expect(
      await metric(metrics, 'alcantara_playout_lease{state="active"}'),
    ).toMatch(/ 1$/);
  });

  it('stands by until it takes the lock, then runs the waiting steps in order and only then reports active', async () => {
    const metrics = new ManagedMetricsService();
    const conn = connection([false, false, true]);
    const exit = jest.fn();
    const lease = new PlayoutLease(metrics, {
      lock: true,
      candidate: false,
      connect: async () => conn,
      exit,
    });
    const order: string[] = [];
    expect(lease.whenActive(() => order.push('engine'))).toBeUndefined();
    lease.whenActive(async () => {
      expect(lease.current).toBe('standby');
      order.push('telemetry');
    });
    const waiting = lease.waitUntilActive(60_000);
    lease.start();
    lease.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(lease.current).toBe('standby');
    expect(conn.queries[0]).toEqual({
      sql: 'SELECT pg_try_advisory_lock($1) AS held',
      values: [PLAYOUT_LEASE_KEY],
    });
    await jest.advanceTimersByTimeAsync(LEASE_ATTEMPT_MS * 2);
    expect(lease.current).toBe('active');
    expect(order).toEqual(['engine', 'telemetry']);
    await expect(waiting).resolves.toBe(true);
    expect(
      await metric(metrics, 'alcantara_playout_lease{state="standby"}'),
    ).toMatch(/ 0$/);
    // A step registered after activation runs at once.
    await lease.whenActive(() => order.push('late'));
    expect(order).toEqual(['engine', 'telemetry', 'late']);
    expect(exit).not.toHaveBeenCalled();
    await lease.beforeApplicationShutdown();
  });

  it('keeps going when a start-up step fails', async () => {
    const lease = new PlayoutLease(new ManagedMetricsService(), {
      lock: true,
      candidate: false,
      connect: async () => connection(),
      exit: jest.fn(),
    });
    const order: string[] = [];
    lease.whenActive(() => {
      throw new Error('boom');
    });
    lease.whenActive(() => {
      throw 'plain';
    });
    lease.whenActive(() => order.push('after'));
    lease.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['after']);
    await lease.beforeApplicationShutdown();
  });

  it('never asks for the lock as a deploy candidate', async () => {
    const connect = jest.fn();
    const lease = new PlayoutLease(new ManagedMetricsService(), {
      lock: true,
      candidate: true,
      connect,
      exit: jest.fn(),
    });
    lease.start();
    await jest.advanceTimersByTimeAsync(LEASE_ATTEMPT_MS * 3);
    expect(lease.current).toBe('standby');
    expect(connect).not.toHaveBeenCalled();
    const wait = lease.waitUntilActive(1_000);
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(wait).resolves.toBe(false);
  });

  it('opens a new connection after a failed attempt, and stops trying once destroyed', async () => {
    const first = connection();
    (first.query as jest.Mock).mockRejectedValueOnce(
      new Error('database away'),
    );
    const second = connection([false]);
    const connect = jest
      .fn()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce('refused')
      .mockResolvedValueOnce(second);
    const lease = new PlayoutLease(new ManagedMetricsService(), {
      lock: true,
      candidate: false,
      connect,
      exit: jest.fn(),
    });
    lease.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(first.ended).toBe(true);
    await jest.advanceTimersByTimeAsync(LEASE_ATTEMPT_MS * 2);
    expect(connect).toHaveBeenCalledTimes(3);
    await lease.beforeApplicationShutdown();
    expect(second.ended).toBe(true);
    await jest.advanceTimersByTimeAsync(LEASE_ATTEMPT_MS * 3);
    expect(connect).toHaveBeenCalledTimes(3);
    // Destroyed before an attempt was due: nothing more happens.
    await lease.beforeApplicationShutdown();
  });

  it('ends the process when the held lock connection fails, closes or stops answering', async () => {
    for (const fail of ['error', 'end', 'liveness'] as const) {
      const metrics = new ManagedMetricsService();
      const conn = connection();
      const exit = jest.fn();
      const lease = new PlayoutLease(metrics, {
        lock: true,
        candidate: false,
        connect: async () => conn,
        exit,
      });
      lease.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(lease.current).toBe('active');
      if (fail === 'liveness') {
        conn.failLiveness();
        await jest.advanceTimersByTimeAsync(LEASE_LIVENESS_MS);
      } else conn.emit(fail);
      expect(exit).toHaveBeenCalledWith(1);
      expect(
        await metric(metrics, 'alcantara_playout_lease_lost_total'),
      ).toMatch(/ 1$/);
      await lease.beforeApplicationShutdown();
    }
  });

  it('ignores a connection that ends while standing by or shutting down', async () => {
    const conn = connection([false]);
    const exit = jest.fn();
    const lease = new PlayoutLease(new ManagedMetricsService(), {
      lock: true,
      candidate: false,
      connect: async () => conn,
      exit,
    });
    lease.start();
    await jest.advanceTimersByTimeAsync(0);
    conn.emit('end');
    await lease.beforeApplicationShutdown();
    conn.emit('error');
    expect(exit).not.toHaveBeenCalled();
  });

  it('times out a wait, and lets a later activation through to waits still open', async () => {
    const lease = new PlayoutLease(new ManagedMetricsService(), {
      lock: true,
      candidate: false,
      connect: async () => connection([false, true]),
      exit: jest.fn(),
    });
    const early = lease.waitUntilActive(100);
    await jest.advanceTimersByTimeAsync(100);
    await expect(early).resolves.toBe(false);
    const late = lease.waitUntilActive(10_000);
    lease.start();
    await jest.advanceTimersByTimeAsync(LEASE_ATTEMPT_MS);
    await expect(late).resolves.toBe(true);
    await lease.beforeApplicationShutdown();
  });

  it('defaults to the lock in production, the candidate flag from the environment, and its own pg connection', async () => {
    const saved = { ...process.env };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.ALCANTARA_DEPLOY_CANDIDATE;
      expect(new PlayoutLease(new ManagedMetricsService()).current).toBe(
        'standby',
      );
      process.env.NODE_ENV = 'test';
      expect(new PlayoutLease(new ManagedMetricsService()).current).toBe(
        'active',
      );
      process.env.ALCANTARA_DEPLOY_CANDIDATE = '1';
      expect(new PlayoutLease(new ManagedMetricsService()).current).toBe(
        'standby',
      );
    } finally {
      process.env = saved;
    }
  });
});

describe('startWhenActive', () => {
  it('runs at once and returns the result where no lease is wired, and defers to the lease otherwise', async () => {
    expect(startWhenActive(undefined, () => 7)).toBe(7);
    const lease = new PlayoutLease(new ManagedMetricsService(), {
      lock: false,
      candidate: false,
    });
    const steps: string[] = [];
    await startWhenActive(lease, () => steps.push('now'));
    expect(steps).toEqual(['now']);
  });
});

describe('PlayoutLease edges', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('asks for nothing when started after it was destroyed, and drops a failed attempt that lands during shutdown', async () => {
    const connect = jest.fn();
    const destroyed = new PlayoutLease(new ManagedMetricsService(), {
      lock: true,
      candidate: false,
      connect,
      exit: jest.fn(),
    });
    await destroyed.beforeApplicationShutdown();
    destroyed.start();
    await jest.advanceTimersByTimeAsync(LEASE_ATTEMPT_MS);
    expect(connect).not.toHaveBeenCalled();

    let refuse: (reason: unknown) => void = () => undefined;
    const slow = jest.fn(
      () =>
        new Promise<LeaseConnection>((_resolve, reject) => (refuse = reject)),
    );
    const lease = new PlayoutLease(new ManagedMetricsService(), {
      lock: true,
      candidate: false,
      connect: slow,
      exit: jest.fn(),
    });
    lease.start();
    await jest.advanceTimersByTimeAsync(0);
    await lease.beforeApplicationShutdown();
    refuse(new Error('late'));
    await jest.advanceTimersByTimeAsync(LEASE_ATTEMPT_MS * 2);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('exits the process by default', () => {
    const exit = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    try {
      defaultPlayoutLeaseOptions().exit(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
  });
});

describe('PlayoutLease closing a broken connection', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('carries on when closing the connection fails, after a failed attempt and at shutdown', async () => {
    const broken: LeaseConnection = {
      query: jest
        .fn()
        .mockRejectedValueOnce(new Error('gone'))
        .mockResolvedValue({ rows: [{ held: false }] }),
      end: jest.fn().mockRejectedValue(new Error('already closed')),
      on: jest.fn(),
    };
    const lease = new PlayoutLease(new ManagedMetricsService(), {
      lock: true,
      candidate: false,
      connect: async () => broken,
      exit: jest.fn(),
    });
    lease.start();
    await jest.advanceTimersByTimeAsync(LEASE_ATTEMPT_MS);
    expect(broken.end).toHaveBeenCalledTimes(1);
    await expect(lease.beforeApplicationShutdown()).resolves.toBeUndefined();
    expect(broken.end).toHaveBeenCalledTimes(2);
  });
});
