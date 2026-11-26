import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261126020000_as_run_flight_cue/migration.sql',
  ),
  'utf8',
);
const schema = readFileSync(
  join(process.cwd(), 'prisma/schema.prisma'),
  'utf8',
);

describe('as-run flight cue migration (#726)', () => {
  it('is additive only: two nullable columns and an index, no backfill', () => {
    const statements = migration
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('--'));
    expect(statements).toEqual([
      'ALTER TABLE "AsRunRecord" ADD COLUMN "flightSequenceId" INTEGER;',
      'ALTER TABLE "AsRunRecord" ADD COLUMN "flightCueId" TEXT;',
      'CREATE INDEX "AsRunRecord_flightSequenceId_idx" ON "AsRunRecord"("flightSequenceId");',
    ]);
    expect(migration).not.toMatch(/\b(DROP|UPDATE|DELETE|RENAME|DEFAULT)\b/i);
  });

  it('matches the Prisma schema', () => {
    expect(schema).toMatch(/\n\s*flightSequenceId\s+Int\?\n/);
    expect(schema).toMatch(/\n\s*flightCueId\s+String\?\n/);
    expect(schema).toMatch(/@@index\(\[flightSequenceId\]\)/);
  });
});
