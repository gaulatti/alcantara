import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const migrationPath = join(
  process.cwd(),
  'prisma/migrations/20261115010000_program_table/migration.sql',
);
const migrationSql = readFileSync(migrationPath, 'utf8');

const schemaPath = join(process.cwd(), 'prisma/schema.prisma');
const schemaContent = readFileSync(schemaPath, 'utf8');

describe('Program table migration', () => {
  it('defines model Program in schema.prisma with exact required fields and index', () => {
    expect(schemaContent).toContain('model Program {');
    expect(schemaContent).toContain('programId String   @id');
    expect(schemaContent).toContain('teamId    Int?');
    expect(schemaContent).toContain('channelId String?');
    expect(schemaContent).toContain('createdAt DateTime @default(now())');
    expect(schemaContent).toContain('updatedAt DateTime @updatedAt');
    expect(schemaContent).toContain('@@index([teamId])');
  });

  it('contains repeatable DDL and backfill from all eight tables', () => {
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS "Program"');
    expect(migrationSql).toContain(
      'CREATE INDEX IF NOT EXISTS "Program_teamId_idx" ON "Program"("teamId")',
    );
    expect(migrationSql).toContain('ON CONFLICT ("programId") DO NOTHING');

    const eightTables = [
      'ProgramState',
      'BroadcastDestinationSelection',
      'BroadcastDestinationCommand',
      'BroadcastDestinationRuntime',
      'ExternalSourceProgram',
      'SimilarityDecision',
      'SongIntro',
      'GuestInvitation',
    ];
    for (const table of eightTables) {
      expect(migrationSql).toContain(`FROM "${table}"`);
    }
  });

  it('applies the migration to a seeded database and asserts count matches distinct program ids', async () => {
    const databaseUrl =
      process.env.DATABASE_URL ??
      'postgresql://alcantara:alcantara-password@127.0.0.1:5432/alcantara_test';

    let client: Client | null = null;
    try {
      client = new Client({ connectionString: databaseUrl });
      await client.connect();
    } catch {
      // If no postgres instance is reachable in local dev, skip live db assertions
      return;
    }

    try {
      // Reset Program table
      await client.query('DROP TABLE IF EXISTS "Program" CASCADE');

      // Seed sample programIds into several tables
      await client.query(`
        INSERT INTO "ProgramState" ("programId", "updatedAt") 
        VALUES ('test-prog-1', NOW()), ('test-prog-2', NOW()), ('test-prog-3', NOW())
        ON CONFLICT ("programId") DO UPDATE SET "updatedAt" = NOW()
      `);
      await client.query(`
        INSERT INTO "BroadcastDestinationSelection" ("id", "version", "programId", "selectionHash", "createdBySubject")
        VALUES ('sel-t1', 'v1', 'test-prog-1', 'h1', 'user1'), ('sel-t2', 'v1', 'test-prog-4', 'h2', 'user2')
        ON CONFLICT DO NOTHING
      `);
      await client.query(`
        INSERT INTO "BroadcastDestinationRuntime" ("programId", "updatedAt")
        VALUES ('test-prog-5', NOW())
        ON CONFLICT DO NOTHING
      `);
      await client.query(`
        INSERT INTO "SimilarityDecision" ("programId", "mode", "outcome", "runnerUps")
        VALUES ('test-prog-6', 'auto', 'accepted', '[]'::jsonb)
      `);
      await client.query(`
        INSERT INTO "GuestInvitation" ("id", "tokenHash", "programId", "displayName", "createdByIdentity", "expiresAt", "updatedAt")
        VALUES ('inv-t1', 'hash-t1', 'test-prog-7', 'Guest Test', 'admin', NOW() + INTERVAL '1 hour', NOW())
        ON CONFLICT DO NOTHING
      `);

      // Run migration first time
      await client.query(migrationSql);

      const distinctResult = await client.query(`
        SELECT count(DISTINCT "programId") AS count FROM (
          SELECT "programId" FROM "ProgramState"
          UNION ALL SELECT "programId" FROM "BroadcastDestinationSelection"
          UNION ALL SELECT "programId" FROM "BroadcastDestinationCommand"
          UNION ALL SELECT "programId" FROM "BroadcastDestinationRuntime"
          UNION ALL SELECT "programId" FROM "ExternalSourceProgram"
          UNION ALL SELECT "programId" FROM "SimilarityDecision"
          UNION ALL SELECT "programId" FROM "SongIntro"
          UNION ALL SELECT "programId" FROM "GuestInvitation"
        ) t WHERE "programId" IS NOT NULL
      `);
      const distinctCount = parseInt(distinctResult.rows[0].count, 10);

      const programCountResult = await client.query(
        'SELECT count(*) AS count FROM "Program"',
      );
      const programCount = parseInt(programCountResult.rows[0].count, 10);

      expect(programCount).toBe(distinctCount);
      expect(programCount).toBeGreaterThanOrEqual(7);

      // Verify repeatability by running migration second time
      await client.query(migrationSql);

      const rerunCountResult = await client.query(
        'SELECT count(*) AS count FROM "Program"',
      );
      expect(parseInt(rerunCountResult.rows[0].count, 10)).toBe(programCount);
    } finally {
      await client.end();
    }
  });
});
