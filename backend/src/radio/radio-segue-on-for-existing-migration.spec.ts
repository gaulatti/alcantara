import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// gaulatti/alcantara#180: the data migration that turns segueMode on for existing
// radio programs. Its effect on real rows is proven against PostgreSQL in the
// ticket's evidence; this spec pins the statements so the migration stays
// additive, recorded and repeatable.

const migration = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261120000000_radio_segue_mode_on_for_existing/migration.sql',
  ),
  'utf8',
);
const schema = readFileSync(
  join(process.cwd(), 'prisma/schema.prisma'),
  'utf8',
);

const statements = migration
  .split(';')
  .map((statement) =>
    statement
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
  .filter(Boolean);

describe('segueMode on-for-existing-programs migration', () => {
  it('adds one nullable column, only if it is missing', () => {
    expect(statements[0]).toBe(
      'ALTER TABLE "RadioSettings" ADD COLUMN IF NOT EXISTS "segueModeBeforeDefaultOn" TEXT',
    );
  });

  it('records the previous value and turns segueMode on, only for radio programs not yet on and not yet recorded', () => {
    expect(statements[1]).toBe(
      'UPDATE "RadioSettings" SET "segueModeBeforeDefaultOn" = "segueMode", "segueMode" = \'on\' WHERE "segueMode" <> \'on\' AND "segueModeBeforeDefaultOn" IS NULL AND "programStateId" IN (SELECT "id" FROM "ProgramState" WHERE "type" IN (\'radio\', \'both\'))',
    );
    expect(statements).toHaveLength(2);
  });

  it('never drops or deletes, and writes only RadioSettings', () => {
    expect(migration).not.toMatch(/\b(DROP|DELETE|TRUNCATE|RENAME)\b/i);
    expect(
      migration.match(/"[A-Za-z]+"/g)?.filter((name) => /^"[A-Z]/.test(name)),
    ).toEqual(['"RadioSettings"', '"RadioSettings"', '"ProgramState"']);
    expect(
      migration.match(/\b(UPDATE|ALTER TABLE|INSERT INTO)\s+"(\w+)"/g),
    ).toEqual(['ALTER TABLE "RadioSettings"', 'UPDATE "RadioSettings"']);
  });

  it('matches a nullable Prisma field on RadioSettings', () => {
    expect(schema).toMatch(/\n\s*segueModeBeforeDefaultOn\s+String\?\n/);
  });
});
