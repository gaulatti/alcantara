import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261118000000_as_run_inferred_end/migration.sql',
  ),
  'utf8',
);
const schema = readFileSync(
  join(process.cwd(), 'prisma/schema.prisma'),
  'utf8',
);

describe('as-run inferred-end migration', () => {
  it('is additive only: new nullable or defaulted columns and a unique index', () => {
    const statements = migration
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('--'));
    expect(statements).toEqual([
      'ALTER TABLE "AsRunRecord" ADD COLUMN "playbackRequestId" TEXT;',
      'ALTER TABLE "AsRunRecord" ADD COLUMN "inferred" BOOLEAN NOT NULL DEFAULT false;',
      'ALTER TABLE "AsRunRecord" ADD COLUMN "reviewFlag" TEXT;',
      'CREATE UNIQUE INDEX "AsRunRecord_programId_playbackRequestId_state_key" ON "AsRunRecord"("programId", "playbackRequestId", "state");',
    ]);
    expect(migration).not.toMatch(/\b(DROP|UPDATE|DELETE|RENAME)\b/i);
  });

  it('matches the Prisma schema', () => {
    expect(schema).toMatch(/\n\s*playbackRequestId\s+String\?\n/);
    expect(schema).toMatch(/\n\s*inferred\s+Boolean\s+@default\(false\)\n/);
    expect(schema).toMatch(/\n\s*reviewFlag\s+String\?\n/);
    expect(schema).toMatch(
      /@@unique\(\[programId, playbackRequestId, state\]\)/,
    );
  });
});
