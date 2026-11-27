import { createRequire } from 'node:module';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PLAYOUT_LEASE_KEY, PlayoutLease } from './playout-lease.service';

/**
 * Two backend instances on one database (alcantara#873): exactly one holds the playout lease and runs the engine; the
 * other stands by and takes over when the first lets go or dies. Runs when DATABASE_URL names a PostgreSQL server.
 */
const describeWithDatabase = process.env.DATABASE_URL
  ? describe
  : describe.skip;
type AdminClient = {
  connect(): Promise<void>;
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
};
const { Client } = createRequire(__filename)('pg') as {
  Client: new (config: { connectionString?: string }) => AdminClient;
};

jest.setTimeout(30_000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await sleep(50);
  return check();
}

describeWithDatabase('the playout lease on one database, two instances', () => {
  const leases: PlayoutLease[] = [];
  afterEach(async () => {
    await Promise.all(leases.splice(0).map((lease) => lease.beforeApplicationShutdown()));
  });

  function instance(
    name: string,
    engines: Set<string>,
    starts: string[],
    exit = jest.fn(),
  ) {
    const lease = new PlayoutLease(new ManagedMetricsService(), {
      lock: true,
      candidate: false,
      exit,
    });
    lease.whenActive(() => {
      engines.add(name);
      starts.push(name);
    });
    leases.push(lease);
    return { lease, exit };
  }

  it('lets exactly one instance drive playout, and hands over when it shuts down', async () => {
    const engines = new Set<string>();
    const starts: string[] = [];
    const blue = instance('blue', engines, starts);
    blue.lease.start();
    expect(await until(() => blue.lease.current === 'active')).toBe(true);

    const green = instance('green', engines, starts);
    green.lease.start();
    await sleep(2_500);
    expect(green.lease.current).toBe('standby');
    expect([...engines]).toEqual(['blue']);

    // Blue shuts down (SIGTERM runs onModuleDestroy): its session closes and green takes the lock.
    await blue.lease.beforeApplicationShutdown();
    engines.delete('blue');
    expect(await until(() => green.lease.current === 'active')).toBe(true);
    expect(starts).toEqual(['blue', 'green']);
    expect([...engines]).toEqual(['green']);
  });

  it('stops an instance whose lock connection dies, and the standby takes over', async () => {
    const engines = new Set<string>();
    const starts: string[] = [];
    const blue = instance('blue', engines, starts);
    blue.lease.start();
    expect(await until(() => blue.lease.current === 'active')).toBe(true);
    const green = instance('green', engines, starts);
    green.lease.start();
    await sleep(1_500);

    const admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    try {
      // The session holding the lock is cut, as a database restart or a network drop would.
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND granted`,
        [PLAYOUT_LEASE_KEY],
      );
    } finally {
      await admin.end();
    }
    expect(await until(() => blue.exit.mock.calls.length > 0)).toBe(true);
    expect(blue.exit).toHaveBeenCalledWith(1);
    expect(await until(() => green.lease.current === 'active')).toBe(true);
    expect(starts).toEqual(['blue', 'green']);
  });
});
