import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261122000000_as_run_actor/migration.sql',
  ),
  'utf8',
);
const schema = readFileSync(
  join(process.cwd(), 'prisma/schema.prisma'),
  'utf8',
);

describe('as-run actor migration', () => {
  it('is additive only: three nullable columns, no backfill', () => {
    const statements = migration
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('--'));
    expect(statements).toEqual([
      'ALTER TABLE "AsRunRecord" ADD COLUMN "actorPrincipalId" TEXT;',
      'ALTER TABLE "AsRunRecord" ADD COLUMN "actorVia" TEXT;',
      'ALTER TABLE "AsRunRecord" ADD COLUMN "actorClient" TEXT;',
    ]);
    expect(migration).not.toMatch(/\b(DROP|UPDATE|DELETE|RENAME|DEFAULT)\b/i);
  });

  it('matches the Prisma schema', () => {
    for (const column of ['actorPrincipalId', 'actorVia', 'actorClient']) {
      expect(schema).toMatch(new RegExp(`\\n\\s*${column}\\s+String\\?\\n`));
    }
  });
});
