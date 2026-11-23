import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { MediaAnalysisService } from '../src/media-analysis/media-analysis.service';
import { PrismaService } from '../src/prisma.service';

// gaulatti/alcantara#296 against real PostgreSQL with the committed migrations applied: the
// duration migration is additive on a table that already holds rows, and the candidate query
// takes every pending or retryable asset before an analysed asset that only lacks a length.

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261122010000_media_analysis_duration/migration.sql',
  ),
  'utf8',
);
const statementsOf = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('--'));

describeWithDatabase('media analysis duration (PostgreSQL e2e)', () => {
  const suffix = randomUUID().replace(/-/g, '');
  const scratch = `e2e_duration_${suffix}`;
  let prisma: PrismaService;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await prisma.$executeRawUnsafe(
      `DROP SCHEMA IF EXISTS "${scratch}" CASCADE`,
    );
    await prisma.$disconnect();
  });

  it('adds one nullable column to a copy that already has rows, leaving them unchanged', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${scratch}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${scratch}"`);
      // The table as it was before the migration: the live table without the new column.
      await tx.$executeRawUnsafe(
        `CREATE TABLE "MediaAssetAnalysis" (LIKE public."MediaAssetAnalysis" INCLUDING ALL)`,
      );
      await tx.$executeRawUnsafe(
        `ALTER TABLE "MediaAssetAnalysis" DROP COLUMN "durationSeconds"`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "MediaAssetAnalysis" ("assetId", status, "cueOutSeconds", "integratedLufs", attempts, "updatedAt")
         VALUES ('a', 'success', 200.5, -9.8, 1, now()), ('b', 'pending', NULL, NULL, 1, now())`,
      );
      const read = () =>
        tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `SELECT * FROM "MediaAssetAnalysis" ORDER BY "assetId"`,
        );
      const before = await read();

      for (const statement of statementsOf(migrationSql)) {
        await tx.$executeRawUnsafe(statement);
      }

      const after = await read();
      expect(after).toHaveLength(2);
      for (const [index, row] of after.entries()) {
        expect(row.durationSeconds).toBeNull();
        expect(
          Object.fromEntries(
            Object.entries(row).filter(([key]) => key !== 'durationSeconds'),
          ),
        ).toEqual(before[index]);
      }
    });
  });

  it('takes a pending asset before one that only lacks a length, and never one that has it', async () => {
    const now = new Date('2026-11-22T12:00:00.000Z');
    const old = '2026-11-20T12:00:00.000Z';
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${scratch}"`);
      // Copies of both tables as the migrations leave them, so the candidate query runs unchanged.
      await tx.$executeRawUnsafe(
        `CREATE TABLE "MediaAsset" (LIKE public."MediaAsset" INCLUDING DEFAULTS)`,
      );
      await tx.$executeRawUnsafe(`DROP TABLE "MediaAssetAnalysis"`);
      await tx.$executeRawUnsafe(
        `CREATE TABLE "MediaAssetAnalysis" (LIKE public."MediaAssetAnalysis" INCLUDING DEFAULTS)`,
      );
      const asset = (id: string, createdAt: string) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "MediaAsset" (id, "mediaType", name, "sourceUrl", "createdAt", "updatedAt")
           VALUES ('${id}', 'AUDIO', '${id}', 'https://media.test/${id}.mp3', '${createdAt}', '${createdAt}')`,
        );
      const analysis = (
        id: string,
        fields: {
          status: string;
          duration: number | null;
          attempts?: number;
          touchedAt?: string;
          nextAttemptAt?: string | null;
        },
      ) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "MediaAssetAnalysis" ("assetId", status, "durationSeconds", attempts, "sourceUrl", "nextAttemptAt", "updatedAt")
           VALUES ('${id}', '${fields.status}', ${fields.duration ?? 'NULL'}, ${fields.attempts ?? 1},
                   'https://media.test/${id}.mp3',
                   ${fields.nextAttemptAt ? `'${fields.nextAttemptAt}'` : 'NULL'},
                   '${fields.touchedAt ?? old}')`,
        );

      // The newest asset has no analysis yet; the others are, newest first: a retry that is due, one that
      // has a length, one without a length (old), one without a length touched a minute ago, one without a
      // length that used its attempts, and a failed one whose retry is not due.
      await asset('new-upload', '2026-11-22T11:00:00Z');
      await asset('retry-due', '2026-11-01T00:00:00Z');
      await analysis('retry-due', {
        status: 'failed',
        duration: null,
        nextAttemptAt: '2026-11-22T11:59:00Z',
      });
      await asset('has-length', '2026-11-21T00:00:00Z');
      await analysis('has-length', { status: 'success', duration: 200 });
      await asset('needs-length-old', '2026-10-01T00:00:00Z');
      await analysis('needs-length-old', { status: 'success', duration: null });
      await asset('needs-length-recent', '2026-11-19T00:00:00Z');
      await analysis('needs-length-recent', {
        status: 'success',
        duration: null,
        touchedAt: '2026-11-22T11:59:00Z',
      });
      await asset('needs-length-spent', '2026-11-18T00:00:00Z');
      await analysis('needs-length-spent', {
        status: 'success',
        duration: null,
        attempts: 3,
      });
      await asset('retry-later', '2026-11-17T00:00:00Z');
      await analysis('retry-later', {
        status: 'failed',
        duration: null,
        nextAttemptAt: '2026-11-23T00:00:00Z',
      });

      const analyzed: string[] = [];
      const updates: unknown[] = [];
      const metrics = {
        record: jest.fn(),
        setBacklog: jest.fn(),
        setDurationBackfill: jest.fn(),
      };
      const resolved = <T>(value: T) => Promise.resolve(value);
      const service = new MediaAnalysisService(
        {
          $queryRaw: (...args: Parameters<typeof tx.$queryRaw>) =>
            tx.$queryRaw(...args),
          mediaAssetAnalysis: {
            create: jest.fn(() => resolved({})),
            updateMany: jest.fn((args: unknown) => {
              updates.push(args);
              return resolved({ count: 1 });
            }),
          },
        } as never,
        metrics as never,
        {
          analyze: jest.fn((url: string) => {
            analyzed.push(url);
            return resolved({
              durationSeconds: 180,
              cueInSeconds: null,
              cueOutSeconds: null,
              integratedLufs: -12,
              truePeakDbtp: -1,
              isrc: null,
              musicbrainzRecordingId: null,
            });
          }),
        } as never,
      );
      const names = () =>
        analyzed.map((url) => /test\/(.+)\.mp3/.exec(url)![1]);

      // Every asset that needs a first or a repeated analysis goes first, newest first.
      await service.runOnce(now);
      expect(names()).toEqual(['new-upload']);
      expect(metrics.setBacklog).toHaveBeenLastCalledWith(2);
      expect(metrics.setDurationBackfill).toHaveBeenLastCalledWith(1);
      await tx.$executeRawUnsafe(
        `INSERT INTO "MediaAssetAnalysis" ("assetId", status, "durationSeconds", attempts, "sourceUrl", "updatedAt")
         VALUES ('new-upload', 'success', 180, 1, 'https://media.test/new-upload.mp3', now())`,
      );
      await service.runOnce(now);
      expect(names()).toEqual(['new-upload', 'retry-due']);
      await tx.$executeRawUnsafe(
        `UPDATE "MediaAssetAnalysis" SET status = 'success', "durationSeconds" = 180, "nextAttemptAt" = NULL WHERE "assetId" = 'retry-due'`,
      );

      // Then the one analysed asset that only lacks a length and can be measured now.
      await service.runOnce(now);
      expect(names()).toEqual(['new-upload', 'retry-due', 'needs-length-old']);
      expect(metrics.setBacklog).toHaveBeenLastCalledWith(0);
      expect(metrics.setDurationBackfill).toHaveBeenLastCalledWith(1);
      expect(updates.at(-1)).toEqual({
        where: {
          assetId: 'needs-length-old',
          sourceUrl: 'https://media.test/needs-length-old.mp3',
          status: 'success',
          durationSeconds: null,
        },
        data: { durationSeconds: 180 },
      });
      await tx.$executeRawUnsafe(
        `UPDATE "MediaAssetAnalysis" SET "durationSeconds" = 180 WHERE "assetId" = 'needs-length-old'`,
      );

      // Nothing more: a length that is stored is never measured again, a row touched a minute ago
      // waits, one that used its attempts and a retry that is not due stay as they are.
      await expect(service.runOnce(now)).resolves.toBe(false);
      expect(names()).toHaveLength(3);
      expect(metrics.setDurationBackfill).toHaveBeenLastCalledWith(0);

      // The recent one is taken once its half hour has passed.
      await service.runOnce(new Date(now.getTime() + 31 * 60_000));
      expect(names().at(-1)).toBe('needs-length-recent');
    });
  });
});
