import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

// gaulatti/alcantara#122: the one-off backfill that gives operator change records written with no team their
// program's team. Unit cases on a stand-in client; the SQL itself against PostgreSQL when DATABASE_URL names one.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const script = require('../../scripts/backfill-change-record-teams.cjs') as {
  backfill(options: { db: { query: (text: string) => Promise<any> }; apply: boolean; say: (line: string) => void }): Promise<{
    settable: number;
    no_program: number;
    program_without_team: number;
    updated: number;
  }>;
  hostAllowed(url: string, allowRemote: boolean): boolean;
  COUNT_SQL: string;
  UPDATE_SQL: string;
};

function fakeDb(counts = { settable: 4, no_program: 1, program_without_team: 1 }, rowCount = counts.settable) {
  const queries: string[] = [];
  return {
    queries,
    query: jest.fn(async (text: string) => {
      queries.push(text.trim().split(/\s+/)[0]);
      if (text === script.COUNT_SQL) return { rows: [counts] };
      if (text === script.UPDATE_SQL) return { rowCount };
      return { rows: [] };
    }),
  };
}

describe('backfill-change-record-teams', () => {
  it('counts on a dry run, read only, and writes nothing', async () => {
    const db = fakeDb();
    const said: string[] = [];
    const result = await script.backfill({ db, apply: false, say: (line) => said.push(line) });
    expect(db.queries).toEqual(['BEGIN', 'SELECT', 'ROLLBACK']);
    expect(db.query).toHaveBeenNthCalledWith(1, 'BEGIN READ ONLY');
    expect(result.updated).toBe(0);
    expect(said).toEqual([
      'records with no team: 6',
      "  settable from their program's team: 4",
      '  no program (keep no team): 1',
      '  program without a team (keep no team): 1',
      'dry run: nothing written; --apply would set 4',
    ]);
  });

  it('sets the counted records in one transaction on apply', async () => {
    const db = fakeDb();
    const said: string[] = [];
    expect((await script.backfill({ db, apply: true, say: (line) => said.push(line) })).updated).toBe(4);
    expect(db.queries).toEqual(['BEGIN', 'SELECT', 'UPDATE', 'COMMIT']);
    expect(said.at(-1)).toBe('applied: set 4');
  });

  it('rolls back an apply that would set a different number than it counted', async () => {
    const db = fakeDb(undefined, 5);
    await expect(script.backfill({ db, apply: true, say: () => undefined })).rejects.toThrow('would set 5, counted 4; nothing written');
    expect(db.queries.at(-1)).toBe('ROLLBACK');
  });

  it('only ever touches records with no team, through their own Program row', () => {
    expect(script.UPDATE_SQL).toMatch(/WHERE r\."teamId" IS NULL AND r\."programId" = p\."programId" AND p\."teamId" IS NOT NULL/);
  });

  it('writes only to a local database unless --allow-remote is given', () => {
    expect(script.hostAllowed('postgresql://u:p@postgres:5432/db', false)).toBe(true);
    expect(script.hostAllowed('postgresql://u:p@db.example.test:5432/db', false)).toBe(false);
    expect(script.hostAllowed('postgresql://u:p@db.example.test:5432/db', true)).toBe(true);
  });
});

const databaseUrl = process.env.DATABASE_URL;
(databaseUrl ? describe : describe.skip)('backfill-change-record-teams against PostgreSQL', () => {
  const tag = `backfill-122-${process.pid}-${Date.now()}`;
  const owned = `${tag}-owned`;
  const unowned = `${tag}-unowned`;
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    await db.query('INSERT INTO "Program" ("programId", "teamId", "updatedAt") VALUES ($1, 41, now()), ($2, NULL, now())', [owned, unowned]);
    const insert = (programId: string | null, teamId: number | null) =>
      db.query(
        'INSERT INTO "OperatorChangeRecord" ("id", "teamId", "programId", "principal", "via", "client", "capability", "summary") VALUES ($1, $2, $3, NULL, $4, NULL, $5, $6)',
        [randomUUID(), teamId, programId, 'console', `${tag}.change`, JSON.stringify({ changed: [] })],
      );
    await insert(owned, null);
    await insert(owned, null);
    await insert(owned, 99);
    await insert(unowned, null);
    await insert(null, null);
  });

  afterAll(async () => {
    await db.query('DELETE FROM "OperatorChangeRecord" WHERE "capability" = $1', [`${tag}.change`]);
    await db.query('DELETE FROM "Program" WHERE "programId" = ANY($1)', [[owned, unowned]]);
    await db.end();
  });

  const teams = async () =>
    (
      await db.query('SELECT "programId", "teamId" FROM "OperatorChangeRecord" WHERE "capability" = $1 ORDER BY "programId", "teamId"', [
        `${tag}.change`,
      ])
    ).rows.map((row: { programId: string | null; teamId: number | null }) => [row.programId?.replace(tag, '') ?? null, row.teamId]);

  it("gives each record with no team its program's team, keeps every other record, and does nothing a second time", async () => {
    const run = (apply: boolean) => script.backfill({ db, apply, say: () => undefined });
    await run(false);
    expect(await teams()).toEqual([
      ['-owned', 99],
      ['-owned', null],
      ['-owned', null],
      ['-unowned', null],
      [null, null],
    ]);
    await run(true);
    expect(await teams()).toEqual([
      ['-owned', 41],
      ['-owned', 41],
      ['-owned', 99],
      ['-unowned', null],
      [null, null],
    ]);
    const again = await run(false);
    expect(again.updated).toBe(0);
    expect(await teams()).toContainEqual(['-owned', 41]);
  });
});
