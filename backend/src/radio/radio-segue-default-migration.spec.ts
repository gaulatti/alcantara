import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261117000000_radio_segue_mode_default_on/migration.sql',
  ),
  'utf8',
);
const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');

describe('segueMode default-on migration', () => {
  it('changes only the column default, so existing programs keep their stored segueMode', () => {
    const statements = migration
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('--'));
    expect(statements).toEqual([
      `ALTER TABLE "RadioSettings" ALTER COLUMN "segueMode" SET DEFAULT 'on';`,
    ]);
    expect(migration).not.toMatch(/\bUPDATE\b/i);
  });

  it('matches the Prisma schema default', () => {
    expect(schema).toMatch(/\n\s*segueMode\s+String\s+@default\("on"\)\n/);
  });
});
