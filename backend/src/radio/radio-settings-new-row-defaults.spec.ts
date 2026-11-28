import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

type Column = { column_name: string; column_default: string | null };
type PgClient = {
  connect(): Promise<void>;
  query<Row>(sql: string): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
};
type PgClientClass = new (config: { connectionString?: string }) => PgClient;

// gaulatti/alcantara#164: the defaults for NEW RadioSettings rows match production
// (similarityMode 'on', bumperEnabled true). No existing row is changed by the migration.

const schema = readFileSync(
  join(process.cwd(), 'prisma/schema.prisma'),
  'utf8',
);
const migration = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261123000000_radio_settings_new_row_defaults/migration.sql',
  ),
  'utf8',
);

describe('RadioSettings defaults for new rows (#164)', () => {
  it('declares the new defaults in schema.prisma', () => {
    const model = schema.slice(
      schema.indexOf('model RadioSettings {'),
      schema.indexOf('\n}', schema.indexOf('model RadioSettings {')),
    );
    expect(model).toMatch(/bumperEnabled\s+Boolean\s+@default\(true\)/);
    expect(model).toMatch(/similarityMode\s+String\s+@default\("on"\)/);
  });

  it('sets the same defaults in the migration and updates no existing row', () => {
    expect(migration).toContain(
      'ALTER TABLE "RadioSettings" ALTER COLUMN "bumperEnabled" SET DEFAULT true;',
    );
    expect(migration).toContain(
      `ALTER TABLE "RadioSettings" ALTER COLUMN "similarityMode" SET DEFAULT 'on';`,
    );
    expect(migration).not.toMatch(/\bUPDATE\b/i);
    expect(migration).not.toMatch(/\bINSERT\b/i);
  });

  const url = process.env.DATABASE_URL;
  const describeDb = url ? describe : describe.skip;
  describeDb('against a migrated database', () => {
    it('reports the new column defaults', async () => {
      const client = new (Client as PgClientClass)({ connectionString: url });
      await client.connect();
      try {
        const rows = await client.query<Column>(
          `SELECT column_name, column_default FROM information_schema.columns
           WHERE table_name = 'RadioSettings' AND column_name IN ('bumperEnabled', 'similarityMode')`,
        );
        const byName = Object.fromEntries(
          rows.rows.map((r) => [r.column_name, r.column_default]),
        );
        expect(byName.bumperEnabled).toBe('true');
        expect(byName.similarityMode).toBe("'on'::text");
      } finally {
        await client.end();
      }
    });
  });
});
