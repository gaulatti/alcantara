import { testDatabaseUrl } from '../../test/test-database';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client as UntypedPgClient } from 'pg';

// pg ships without types in this package set. These specs use only the calls below, so this is the typed view of
// the client they get; it is a cast, not a new behaviour.
interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  on(event: 'notice', listener: (notice: { message?: string }) => void): void;
  off(event: 'notice', listener: (notice: { message?: string }) => void): void;
}
const Client = UntypedPgClient as unknown as new (config: {
  connectionString: string | undefined;
}) => PgClient;

// gaulatti/alcantara#122: the backfill of the pre-#148 library rows, run against a real PostgreSQL schema.
const sql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261126000000_library_team_backfill/migration.sql',
  ),
  'utf8',
);
const TARGETS = [
  'BroadcastDestination',
  'BroadcastSettings',
  'Instant',
  'Layout',
  'Media',
  'MediaAsset',
  'MediaGroup',
  'MediaLabel',
  'Scene',
  'Song',
  'Stinger',
  'Program',
  'OperatorChangeRecord',
];
const OTHERS = [
  'ExternalSource',
  'ArtistLabel',
  'BroadcastIngestAccess',
  'BroadcastDestinationKeyChange',
];
const url = testDatabaseUrl();

describe('library team backfill migration', () => {
  const schema = `backfill_${process.pid}`;
  let client: PgClient;

  beforeAll(async () => {
    client = new Client({ connectionString: url.split('?')[0] });
    await client.connect();
  });

  // Everything happens in a transaction that is rolled back: the throwaway tables, named like the real ones, are
  // never visible to the other specs that share this database.
  beforeEach(async () => {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    for (const table of [...TARGETS, ...OTHERS]) {
      await client.query(
        `CREATE TABLE "${table}" ("id" INTEGER PRIMARY KEY, "teamId" INTEGER, "updatedAt" TIMESTAMP DEFAULT '2020-01-01')`,
      );
    }
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  afterAll(async () => {
    await client?.end();
  });

  const put = (table: string, id: number, team: number | null) =>
    client.query(`INSERT INTO "${table}" ("id", "teamId") VALUES ($1, $2)`, [
      id,
      team,
    ]);
  const teams = async (table: string) =>
    (
      await client.query(
        `SELECT "teamId", "updatedAt"::text AS u FROM "${table}" ORDER BY "id"`,
      )
    ).rows;
  const seedUnassigned = async () => {
    for (const table of TARGETS) await put(table, 1, null);
  };

  it('assigns the NULL rows of every target to the one team the tenant tables name, once', async () => {
    await seedUnassigned();
    // The only team is named by a table that is not a target, as in production.
    await put('BroadcastDestinationKeyChange', 1, 1);
    await put('ArtistLabel', 1, 1);
    await put('ArtistLabel', 2, null);
    await put('BroadcastDestination', 2, 1);
    await client.query(sql);
    for (const table of TARGETS) {
      expect((await teams(table))[0]).toEqual({
        teamId: 1,
        u: '2020-01-01 00:00:00',
      });
    }
    expect((await teams('ArtistLabel'))[1].teamId).toBeNull();
    // A second run finds nothing to assign, even if another team appears afterwards.
    await put('ExternalSource', 1, 2);
    await client.query(sql);
    expect((await teams('Song'))[0].teamId).toBe(1);
  });

  it.each([
    ['two teams', [1, 2]],
    ['a team that is not positive', [0]],
  ])('fails and changes nothing with %s', async (_name, found) => {
    await seedUnassigned();
    let id = 2;
    for (const team of found) await put('ExternalSource', id++, team);
    await client.query('SAVEPOINT before_migration');
    await expect(client.query(sql)).rejects.toThrow(
      'cannot tell which team owns the unassigned rows',
    );
    await client.query('ROLLBACK TO SAVEPOINT before_migration');
    for (const table of TARGETS) {
      expect((await teams(table))[0].teamId).toBeNull();
    }
  });

  it('skips with a notice when no tenant table names a team', async () => {
    await seedUnassigned();
    const notices: string[] = [];
    const listen = (notice: { message?: string }) =>
      notices.push(notice.message ?? '');
    client.on('notice', listen);
    await expect(client.query(sql)).resolves.toBeTruthy();
    client.off('notice', listen);
    expect(notices).toEqual([
      expect.stringContaining('this installation has no tenancy'),
    ]);
    for (const table of TARGETS) {
      expect((await teams(table))[0].teamId).toBeNull();
    }
  });

  it('leaves a database with nothing to assign alone, whatever teams it names', async () => {
    await expect(client.query(sql)).resolves.toBeTruthy();
    await put('Song', 1, 1);
    await put('Scene', 1, 2);
    await expect(client.query(sql)).resolves.toBeTruthy();
    expect((await teams('Song'))[0].teamId).toBe(1);
  });

  it('writes no team id of its own', () => {
    expect(sql).not.toMatch(/SET "teamId" = \d/);
  });
});
