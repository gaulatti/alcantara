// gaulatti/alcantara#335: the branding migration is additive and its Program backfill is idempotent.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migrationSql = readFileSync(
  join(process.cwd(), 'prisma/migrations/20261123120000_program_branding/migration.sql'),
  'utf8',
);

describe('ProgramBranding migration', () => {
  it('creates the branding table keyed on Program with a cascade foreign key', () => {
    expect(migrationSql).toContain('CREATE TABLE "ProgramBranding"');
    expect(migrationSql).toContain('CONSTRAINT "ProgramBranding_pkey" PRIMARY KEY ("programId")');
    expect(migrationSql).toContain('REFERENCES "Program"("programId") ON DELETE CASCADE');
  });

  it('backfills a Program row for every ProgramState that lacks one, and only those', () => {
    expect(migrationSql).toContain('INSERT INTO "Program" ("programId", "teamId", "channelId", "createdAt", "updatedAt")');
    expect(migrationSql).toContain('FROM "ProgramState" ps');
    expect(migrationSql).toContain('WHERE NOT EXISTS (SELECT 1 FROM "Program" p WHERE p."programId" = ps."programId")');
  });

  it('alters no existing table', () => {
    expect(migrationSql).not.toMatch(/ALTER TABLE "(Program|ProgramState)" ALTER/);
    expect(migrationSql).not.toMatch(/DROP /);
  });
});
