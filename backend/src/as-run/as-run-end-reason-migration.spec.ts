import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261119000000_as_run_end_reason/migration.sql',
  ),
  'utf8',
);
const schema = readFileSync(
  join(process.cwd(), 'prisma/schema.prisma'),
  'utf8',
);

describe('as-run end-reason migration', () => {
  it('is additive only: one nullable column, no backfill', () => {
    const statements = migration
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('--'));
    expect(statements).toEqual([
      'ALTER TABLE "AsRunRecord" ADD COLUMN "endReason" TEXT;',
    ]);
    expect(migration).not.toMatch(/\b(DROP|UPDATE|DELETE|RENAME|DEFAULT)\b/i);
  });

  it('matches the Prisma schema', () => {
    expect(schema).toMatch(/\n\s*endReason\s+String\?\n/);
  });
});
