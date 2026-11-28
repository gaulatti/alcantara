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
  backfillStation(options: {
    db: { query: (text: string, values?: unknown[]) => Promise<any> };
    apply: boolean;
    team: number;
    say: (line: string) => void;
  }): Promise<{ settable: number; updated: number }>;
  stationTeamOf(argv: string[], environment?: Record<string, string | undefined>): number | null;
  hostAllowed(url: string, allowRemote: boolean): boolean;
  COUNT_SQL: string;
  UPDATE_SQL: string;
  STATION_COUNT_SQL: string;
  STATION_UPDATE_SQL: string;
  TEAM_HAS_PROGRAM_SQL: string;
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

  it("takes the station team from the backend's POMPEII_TEAM_ID, never the command line, and refuses anything but a positive id", () => {
    expect(script.stationTeamOf(['--apply'], { POMPEII_TEAM_ID: '7' })).toBeNull();
    expect(script.stationTeamOf(['--station-team'], { POMPEII_TEAM_ID: ' 7 ' })).toBe(7);
    expect(script.stationTeamOf(['--station-team', '9'], { POMPEII_TEAM_ID: '7' })).toBe(7);
    for (const raw of [undefined, '', '0', '-2', 'x', '1.5'])
      expect(() => script.stationTeamOf(['--station-team'], { POMPEII_TEAM_ID: raw })).toThrow(
        '--station-team needs a positive POMPEII_TEAM_ID; nothing written',
      );
  });

  it('gives the records with no program the station team, counted first, with the same dry run and rollback', async () => {
    let programsOfTeam = 2;
    const run = async (apply: boolean, rowCount = 4) => {
      const queries: Array<[string, unknown[] | undefined]> = [];
      const said: string[] = [];
      const db = {
        query: jest.fn(async (text: string, values?: unknown[]) => {
          queries.push([text.trim().split(/\s+/)[0], values]);
          if (text === script.TEAM_HAS_PROGRAM_SQL) return { rows: [{ programs: programsOfTeam }] };
          if (text === script.STATION_COUNT_SQL) return { rows: [{ settable: 4 }] };
          if (text === script.STATION_UPDATE_SQL) return { rowCount };
          return { rows: [] };
        }),
      };
      const result = await script.backfillStation({ db, apply, team: 7, say: (line) => said.push(line) });
      return { queries, said, result };
    };
    const dry = await run(false);
    expect(dry.queries.map(([verb]) => verb)).toEqual(['BEGIN', 'SELECT', 'SELECT', 'ROLLBACK']);
    expect(dry.queries[1][1]).toEqual([7]);
    expect(dry.said).toEqual(['records with no program and no team: 4', 'dry run: nothing written; --apply would give 4 the station team']);
    const applied = await run(true);
    expect(applied.queries.map(([verb]) => verb)).toEqual(['BEGIN', 'SELECT', 'SELECT', 'UPDATE', 'COMMIT']);
    expect(applied.queries[3][1]).toEqual([7]);
    expect(applied.result.updated).toBe(4);
    await expect(run(true, 3)).rejects.toThrow('would set 3, counted 4; nothing written');
    programsOfTeam = 0;
    await expect(run(true)).rejects.toThrow('no program belongs to the station team; nothing written');
    expect(script.STATION_UPDATE_SQL).toMatch(/WHERE "teamId" IS NULL AND "programId" IS NULL/);
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

  // The station mode's apply touches every record that names no program, other suites' included, so on the shared
  // database only its read-only paths run: the refusal and the dry run.
  it('refuses a station team no program belongs to, and counts on a dry run without writing', async () => {
    await expect(script.backfillStation({ db, apply: true, team: 999_001, say: () => undefined })).rejects.toThrow(
      'no program belongs to the station team',
    );
    const dry = await script.backfillStation({ db, apply: false, team: 41, say: () => undefined });
    expect(dry.settable).toBeGreaterThanOrEqual(1);
    expect(dry.updated).toBe(0);
    expect(await teams()).toContainEqual([null, null]);
  });
});
