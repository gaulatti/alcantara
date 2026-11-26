import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

// gaulatti/alcantara#122: the backfill of the pre-#148 library rows, run against a real PostgreSQL schema.
const sql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261126000000_library_team_backfill/migration.sql',
  ),
  'utf8',
);
const TABLES = [
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
];
const url =
  process.env.DATABASE_URL ||
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

describe('library team backfill migration', () => {
  const schema = `backfill_${process.pid}`;
  let client: Client;

  beforeAll(async () => {
    const parsed = new URL(url);
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname))
      throw new Error('backfill spec needs a local database');
    client = new Client({ connectionString: url.split('?')[0] });
    await client.connect();
  });

  beforeEach(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(
      'CREATE TABLE "Program" ("programId" TEXT PRIMARY KEY, "teamId" INTEGER)',
    );
    for (const table of TABLES) {
      await client.query(
        `CREATE TABLE "${table}" ("id" INTEGER PRIMARY KEY, "teamId" INTEGER, "updatedAt" TIMESTAMP DEFAULT '2020-01-01')`,
      );
      await client.query(
        `INSERT INTO "${table}" ("id", "teamId") VALUES (1, NULL), (2, 9)`,
      );
    }
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client?.end();
  });

  const teams = async (table: string) =>
    (
      await client.query(
        `SELECT "teamId", "updatedAt"::text AS u FROM "${table}" ORDER BY "id"`,
      )
    ).rows;

  it('assigns only the NULL rows of the eleven libraries to the team of modoitaliano.fm, once', async () => {
    await client.query(
      `INSERT INTO "Program" VALUES ('modoitaliano.fm', 7), ('other', 3)`,
    );
    await client.query(sql);
    for (const table of TABLES) {
      expect(await teams(table)).toEqual([
        { teamId: 7, u: '2020-01-01 00:00:00' },
        { teamId: 9, u: '2020-01-01 00:00:00' },
      ]);
    }
    await client.query(`UPDATE "Program" SET "teamId" = 8`);
    await client.query(sql);
    expect((await teams('Song')).map((row) => row.teamId)).toEqual([7, 9]);
  });

  it.each([
    ['no such program', `INSERT INTO "Program" VALUES ('other', 3)`],
    ['no team', `INSERT INTO "Program" VALUES ('modoitaliano.fm', NULL)`],
    ['team zero', `INSERT INTO "Program" VALUES ('modoitaliano.fm', 0)`],
  ])('changes nothing with %s', async (_name, insert) => {
    await client.query(insert);
    await client.query(sql);
    for (const table of TABLES) {
      expect((await teams(table)).map((row) => row.teamId)).toEqual([null, 9]);
    }
  });

  it('writes no team id of its own', () => {
    expect(sql).not.toMatch(/SET "teamId" = \d/);
  });
});
