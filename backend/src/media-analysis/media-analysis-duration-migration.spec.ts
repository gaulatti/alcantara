import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261122010000_media_analysis_duration/migration.sql',
  ),
  'utf8',
);
const schema = readFileSync(
  join(process.cwd(), 'prisma/schema.prisma'),
  'utf8',
);

describe('media analysis duration migration', () => {
  it('is additive only: one nullable column, no backfill', () => {
    const statements = migration
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('--'));
    expect(statements).toEqual([
      'ALTER TABLE "MediaAssetAnalysis" ADD COLUMN "durationSeconds" DOUBLE PRECISION;',
    ]);
    expect(migration).not.toMatch(/\b(DROP|UPDATE|DELETE|RENAME|DEFAULT)\b/i);
  });

  it('matches the Prisma schema', () => {
    expect(schema).toMatch(
      /model MediaAssetAnalysis \{[^}]*\n\s*durationSeconds\s+Float\?\n/,
    );
  });
});
