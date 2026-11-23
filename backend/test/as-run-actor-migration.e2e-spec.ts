import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AsRunService } from '../src/as-run/as-run.service';
import { PrismaService } from '../src/prisma.service';

// gaulatti/alcantara#213 against real PostgreSQL with the committed
// migrations applied: the actor migration is additive on a table that already
// holds rows, and the service persists and exports the actor.

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261122000000_as_run_actor/migration.sql',
  ),
  'utf8',
);

describeWithDatabase('as-run actor columns (PostgreSQL e2e)', () => {
  const suffix = randomUUID().replace(/-/g, '');
  const scratch = `e2e_actor_${suffix}`;
  const programId = `e2e-actor-${suffix}`;
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DROP SCHEMA IF EXISTS "${scratch}" CASCADE`,
    );
    await prisma.asRunRecord.deleteMany({ where: { programId } });
    await prisma.$disconnect();
  });

  it('adds three nullable columns to a copy that already has rows, leaving them unchanged', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${scratch}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${scratch}"`);
      // The table as it was before the migration: the live table without the
      // three new columns.
      await tx.$executeRawUnsafe(
        `CREATE TABLE "AsRunRecord" (LIKE public."AsRunRecord" INCLUDING ALL)`,
      );
      await tx.$executeRawUnsafe(
        `ALTER TABLE "AsRunRecord" DROP COLUMN "actorPrincipalId", DROP COLUMN "actorVia", DROP COLUMN "actorClient"`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "AsRunRecord" ("programId","songId",state,at,"playbackRequestId","endReason")
         VALUES ('p',1,'started','2026-11-01T10:00:00Z','r1',NULL),
                ('p',1,'ended','2026-11-01T10:03:00Z','r1','stopped')`,
      );
      const read = () =>
        tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `SELECT * FROM "AsRunRecord" ORDER BY id`,
        );
      const before = await read();

      for (const statement of migrationSql
        .split('\n')
        .filter((line) => line.trim() && !line.trim().startsWith('--'))) {
        await tx.$executeRawUnsafe(statement);
      }

      const after = await read();
      expect(after).toHaveLength(2);
      for (const [index, row] of before.entries()) {
        expect(after[index]).toEqual({
          ...row,
          actorPrincipalId: null,
          actorVia: null,
          actorClient: null,
        });
      }
      const columns = await tx.$queryRawUnsafe<
        Array<{ column_name: string; is_nullable: string }>
      >(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_schema = '${scratch}' AND table_name = 'AsRunRecord' AND column_name LIKE 'actor%' ORDER BY column_name`,
      );
      expect(columns).toEqual([
        { column_name: 'actorClient', is_nullable: 'YES' },
        { column_name: 'actorPrincipalId', is_nullable: 'YES' },
        { column_name: 'actorVia', is_nullable: 'YES' },
      ]);
    });
  });

  it('persists the actor through the service and exports it', async () => {
    const service = new AsRunService(prisma, {
      trackEvents$: { subscribe: jest.fn() },
    } as never);
    const at = new Date('2026-11-01T10:00:00Z');
    await service.handleTrackEvent({
      programId,
      type: 'track.started',
      playbackRequestId: `${suffix}-1`,
      title: null,
      artist: null,
      url: null,
      at,
      actorPrincipalId: 'principal-1',
      actorVia: 'mcp',
      actorClient: 'claude-desktop',
    });
    await service.handleTrackEvent({
      programId,
      type: 'track.ended',
      playbackRequestId: `${suffix}-1`,
      title: null,
      artist: null,
      url: null,
      at: new Date(at.getTime() + 60_000),
    });
    const [header, started, ended] = (
      await service.export(programId, {})
    ).split('\n');
    expect(header.split(',').slice(-3)).toEqual([
      'actorPrincipalId',
      'actorVia',
      'actorClient',
    ]);
    expect(started.split(',').slice(-3)).toEqual([
      'principal-1',
      'mcp',
      'claude-desktop',
    ]);
    expect(ended.split(',').slice(-3)).toEqual(['', '', '']);
  });
});
