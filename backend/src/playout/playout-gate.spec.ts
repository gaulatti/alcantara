import { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  HOLD_LIMIT_MS,
  MAX_HELD,
  PlayoutHold,
  RETRY_AFTER_SECONDS,
  gateUpgrades,
  installPlayoutGate,
  isNeverHeld,
} from './playout-gate';
import { PlayoutLease } from './playout-lease.service';

// A standby holds requests until it takes the playout lease (alcantara#873), never the health checks or the scrape.

function standby() {
  let activate: () => void = () => undefined;
  const lease = new PlayoutLease(new ManagedMetricsService(), {
    lock: true,
    candidate: false,
    exit: jest.fn(),
    connect: async () => ({
      query: () =>
        new Promise((resolve) => {
          activate = () => resolve({ rows: [{ held: true }] });
        }),
      end: async () => undefined,
      on: () => undefined,
    }),
  });
  return { lease, activate: () => activate() };
}

const metric = async (metrics: ManagedMetricsService, line: string) =>
  (await metrics.render('')).split('\n').find((l) => l.startsWith(line));

describe('isNeverHeld', () => {
  it('answers the health checks and the scrape, and holds everything else', () => {
    for (const url of [
      '/',
      '/?probe=1',
      '/metrics',
      '/health/ready',
      '/health/live?x=1',
    ])
      expect(isNeverHeld(url)).toBe(true);
    for (const url of [
      '/program/main',
      '/healthz',
      '/metricsx',
      '/webrtc/config',
    ])
      expect(isNeverHeld(url)).toBe(false);
  });
});

describe('PlayoutHold', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('lets everything through on an active instance', async () => {
    const lease = new PlayoutLease(new ManagedMetricsService(), {
      lock: false,
      candidate: false,
    });
    await expect(
      new PlayoutHold(lease, new ManagedMetricsService()).admit(
        '/program/main',
      ),
    ).resolves.toEqual({ proceed: true });
  });

  it('holds a standby request until activation, then serves it, and counts it', async () => {
    const metrics = new ManagedMetricsService();
    const { lease, activate } = standby();
    const hold = new PlayoutHold(lease, metrics);
    await expect(hold.admit('/health/ready')).resolves.toEqual({
      proceed: true,
    });
    const held = hold.admit('/program/main');
    lease.start();
    await jest.advanceTimersByTimeAsync(500);
    activate();
    await jest.advanceTimersByTimeAsync(0);
    await expect(held).resolves.toEqual({ proceed: true });
    expect(
      await metric(
        metrics,
        'alcantara_playout_held_requests_total{result="served"}',
      ),
    ).toMatch(/ 1$/);
    await lease.onModuleDestroy();
  });

  it('refuses a request held past the limit, and any beyond the cap', async () => {
    const metrics = new ManagedMetricsService();
    const { lease } = standby();
    const hold = new PlayoutHold(lease, metrics);
    const waiting = Array.from({ length: MAX_HELD }, () =>
      hold.admit('/program/main'),
    );
    await expect(hold.admit('/program/main')).resolves.toEqual({
      proceed: false,
    });
    expect(
      await metric(
        metrics,
        'alcantara_playout_held_requests_total{result="rejected"}',
      ),
    ).toMatch(/ 1$/);
    await jest.advanceTimersByTimeAsync(HOLD_LIMIT_MS);
    for (const decision of await Promise.all(waiting))
      expect(decision).toEqual({ proceed: false });
    expect(
      await metric(
        metrics,
        `alcantara_playout_held_requests_total{result="timeout"}`,
      ),
    ).toMatch(new RegExp(` ${MAX_HELD}$`));
    // The cap frees as requests leave.
    const next = hold.admit('/program/main');
    await jest.advanceTimersByTimeAsync(HOLD_LIMIT_MS);
    await expect(next).resolves.toEqual({ proceed: false });
  });
});

describe('installPlayoutGate', () => {
  it('answers a refused request 503 with Retry-After, and lets an admitted one through', async () => {
    let hook: (
      request: { url: string },
      reply: unknown,
    ) => Promise<unknown> = async () => undefined;
    const fastify = {
      addHook: jest.fn((_name: string, fn: typeof hook) => (hook = fn)),
    };
    const admit = jest
      .fn()
      .mockResolvedValueOnce({ proceed: true })
      .mockResolvedValueOnce({ proceed: false });
    installPlayoutGate(fastify as never, { admit } as unknown as PlayoutHold);
    expect(fastify.addHook).toHaveBeenCalledWith(
      'onRequest',
      expect.any(Function),
    );
    const reply = {
      header: jest.fn(),
      code: jest.fn(),
      send: jest.fn((body: unknown) => body),
    };
    reply.header.mockReturnValue(reply);
    reply.code.mockReturnValue(reply);
    await expect(
      hook({ url: '/program/main' }, reply),
    ).resolves.toBeUndefined();
    await expect(hook({ url: '/program/main' }, reply)).resolves.toEqual({
      statusCode: 503,
      message: 'This backend is taking over; try again shortly.',
    });
    expect(reply.header).toHaveBeenCalledWith(
      'Retry-After',
      String(RETRY_AFTER_SECONDS),
    );
    expect(reply.code).toHaveBeenCalledWith(503);
  });
});

describe('gateUpgrades', () => {
  it('passes admitted upgrades to the realtime listener, refuses the others with 503, and detaches the same listener', async () => {
    const listeners: Array<(...args: unknown[]) => void> = [];
    const server = {
      marker: 'server',
      on: jest.fn((_event: string, listener: (...args: unknown[]) => void) =>
        listeners.push(listener),
      ),
      off: jest.fn(),
    };
    const admit = jest
      .fn()
      .mockResolvedValueOnce({ proceed: true })
      .mockResolvedValueOnce({ proceed: false });
    const facade = gateUpgrades(server, { admit } as unknown as PlayoutHold);
    expect((facade as unknown as { marker: string }).marker).toBe('server');
    const realtime = jest.fn();
    facade.on('upgrade', realtime);
    const socket = { write: jest.fn(), destroy: jest.fn() };
    listeners[0]({ url: '/realtime?role=control' }, socket, Buffer.alloc(0));
    await Promise.resolve();
    await Promise.resolve();
    expect(realtime).toHaveBeenCalledTimes(1);
    listeners[0]({}, socket, Buffer.alloc(0));
    await Promise.resolve();
    await Promise.resolve();
    expect(admit).toHaveBeenLastCalledWith('');
    expect(socket.write).toHaveBeenCalledWith(
      expect.stringContaining('503 Service Unavailable'),
    );
    expect(socket.destroy).toHaveBeenCalled();
    facade.off('upgrade', realtime);
    expect(server.off).toHaveBeenCalledWith('upgrade', listeners[0]);
    // A listener it never wrapped is passed through as it is.
    const stranger = jest.fn();
    facade.off('upgrade', stranger);
    expect(server.off).toHaveBeenLastCalledWith('upgrade', stranger);
  });
});
