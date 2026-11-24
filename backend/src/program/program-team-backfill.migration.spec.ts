import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

// gaulatti/alcantara#478: programs created before #335 have a Program row with teamId NULL. The
// backfill gives each one the single positive team its attached scenes, media groups, stingers and
// external sources agree on, and leaves the rest NULL with a notice. It never overwrites a team and
// changes nothing on a second run. Each case runs the real migration.sql inside a transaction that
// is rolled back, so the shared test database keeps no fixture.

const migration = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261124000000_program_team_backfill/migration.sql',
  ),
  'utf8',
);

describe('Program team backfill migration (#478)', () => {
  it('only writes Program rows, and only where the team is still NULL', () => {
    expect(migration).not.toMatch(/\b(ALTER|DROP|DELETE|TRUNCATE)\b/i);
    expect(migration.match(/\bUPDATE\s+"(\w+)"/g)).toEqual([
      'UPDATE "Program"',
    ]);
    expect(migration).toMatch(
      /WHERE "programId" = program_row\."programId" AND "teamId" IS NULL;/,
    );
  });

  const url = process.env.DATABASE_URL;
  const describeDb = url ? describe : describe.skip;
  describeDb('against a migrated database', () => {
    let client: Client;
    let notices: string[];
    const prefix = `e2e-478-${process.pid}-${Date.now()}`;
    const id = (name: string) => `${prefix}-${name}`;

    beforeEach(async () => {
      client = new Client({ connectionString: url });
      notices = [];
      client.on('notice', (notice) => notices.push(notice.message ?? ''));
      await client.connect();
      await client.query('BEGIN');
    });

    afterEach(async () => {
      await client.query('ROLLBACK');
      await client.end();
    });

    async function program(
      name: string,
      teamId: number | null,
      withRow = true,
    ) {
      const state = await client.query<{ id: number }>(
        `INSERT INTO "ProgramState" ("programId", "updatedAt") VALUES ($1, NOW()) RETURNING "id"`,
        [id(name)],
      );
      if (withRow) {
        await client.query(
          `INSERT INTO "Program" ("programId", "teamId", "updatedAt") VALUES ($1, $2, NOW())`,
          [id(name), teamId],
        );
      }
      return state.rows[0].id;
    }

    let position = 0;
    async function scene(stateId: number, teamId: number | null) {
      const layout = await client.query<{ id: number }>(
        `INSERT INTO "Layout" ("name", "componentType", "settings", "updatedAt")
         VALUES ($1, 'header', '{}', NOW()) RETURNING "id"`,
        [id(`layout-${++position}`)],
      );
      const row = await client.query<{ id: number }>(
        `INSERT INTO "Scene" ("name", "layoutId", "teamId", "updatedAt") VALUES ($1, $2, $3, NOW()) RETURNING "id"`,
        [id(`scene-${position}`), layout.rows[0].id, teamId],
      );
      await client.query(
        `INSERT INTO "ProgramScene" ("programStateId", "sceneId", "position") VALUES ($1, $2, $3)`,
        [stateId, row.rows[0].id, position],
      );
    }

    async function mediaGroup(stateId: number, teamId: number | null) {
      const row = await client.query<{ id: number }>(
        `INSERT INTO "MediaGroup" ("name", "teamId", "updatedAt") VALUES ($1, $2, NOW()) RETURNING "id"`,
        [id(`group-${++position}`), teamId],
      );
      await client.query(
        `INSERT INTO "ProgramMediaGroup" ("programStateId", "mediaGroupId", "position") VALUES ($1, $2, $3)`,
        [stateId, row.rows[0].id, position],
      );
    }

    async function stinger(stateId: number, teamId: number | null) {
      const row = await client.query<{ id: number }>(
        `INSERT INTO "Stinger" ("name", "videoUrl", "teamId", "updatedAt")
         VALUES ($1, 'https://media.example.test/stinger.webm', $2, NOW()) RETURNING "id"`,
        [id(`stinger-${++position}`), teamId],
      );
      await client.query(
        `INSERT INTO "ProgramStinger" ("programStateId", "stingerId", "position") VALUES ($1, $2, $3)`,
        [stateId, row.rows[0].id, position],
      );
    }

    async function externalSource(name: string, teamId: number) {
      const row = await client.query<{ id: string }>(
        `INSERT INTO "ExternalSource" ("id", "teamId", "name", "transport", "transportConfigCiphertext",
           "transportConfigNonce", "configKeyVersion", "createdBySubject", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, 'srt', 'fixture-ciphertext', 'fixture-nonce', 1, 'fixture-subject', NOW())
         RETURNING "id"`,
        [teamId, id(`source-${++position}`)],
      );
      await client.query(
        `INSERT INTO "ExternalSourceProgram" ("sourceId", "programId") VALUES ($1, $2)`,
        [row.rows[0].id, id(name)],
      );
    }

    async function teams() {
      const rows = await client.query<{
        programId: string;
        teamId: number | null;
      }>(
        `SELECT "programId", "teamId" FROM "Program" WHERE "programId" LIKE $1 ORDER BY "programId"`,
        [`${prefix}-%`],
      );
      return Object.fromEntries(
        rows.rows.map((row) => [
          row.programId.slice(prefix.length + 1),
          row.teamId,
        ]),
      );
    }

    it('gives a program the one team its attachments agree on, across all four kinds', async () => {
      const scenes = await program('scenes', null);
      await scene(scenes, 7);
      await scene(scenes, null);
      const groups = await program('groups', null);
      await mediaGroup(groups, 7);
      const stingers = await program('stingers', null);
      await stinger(stingers, 7);
      await program('sources', null);
      await externalSource('sources', 7);
      const mixed = await program('agreeing-kinds', null);
      await scene(mixed, 9);
      await stinger(mixed, 9);
      await externalSource('agreeing-kinds', 9);

      await client.query(migration);

      expect(await teams()).toEqual({
        'agreeing-kinds': 9,
        groups: 7,
        scenes: 7,
        sources: 7,
        stingers: 7,
      });
    });

    it('leaves NULL, and names, a program with two teams or no positive team', async () => {
      const split = await program('split', null);
      await scene(split, 7);
      await mediaGroup(split, 8);
      const untagged = await program('untagged', null);
      await scene(untagged, null);
      await stinger(untagged, 0);
      await program('bare', null);

      await client.query(migration);

      expect(await teams()).toEqual({
        bare: null,
        split: null,
        untagged: null,
      });
      const ours = notices.filter((message) => message.includes(prefix));
      expect(ours).toEqual([
        `program_team_backfill: ${id('bare')} keeps no team (0 candidate teams)`,
        `program_team_backfill: ${id('split')} keeps no team (2 candidate teams)`,
        `program_team_backfill: ${id('untagged')} keeps no team (0 candidate teams)`,
      ]);
    });

    it('never changes a program that already has a team', async () => {
      const owned = await program('owned', 5);
      await scene(owned, 7);

      await client.query(migration);

      expect(await teams()).toEqual({ owned: 5 });
    });

    it('creates the missing Program row of a program state, then derives its team', async () => {
      const orphan = await program('orphan', null, false);
      await scene(orphan, 7);

      await client.query(migration);

      expect(await teams()).toEqual({ orphan: 7 });
    });

    it('changes nothing on a second run', async () => {
      const derived = await program('derived', null);
      await scene(derived, 7);
      const split = await program('split', null);
      await scene(split, 7);
      await scene(split, 8);
      await client.query(migration);
      const once = await client.query(
        `SELECT "programId", "teamId", "updatedAt" FROM "Program" WHERE "programId" LIKE $1 ORDER BY "programId"`,
        [`${prefix}-%`],
      );

      await client.query(migration);

      const twice = await client.query(
        `SELECT "programId", "teamId", "updatedAt" FROM "Program" WHERE "programId" LIKE $1 ORDER BY "programId"`,
        [`${prefix}-%`],
      );
      expect(twice.rows).toEqual(once.rows);
      expect(await teams()).toEqual({ derived: 7, split: null });
    });
  });
});
