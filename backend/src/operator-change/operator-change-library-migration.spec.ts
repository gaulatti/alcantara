import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

/**
 * gaulatti/alcantara#236: OperatorChangeRecord.programId becomes nullable, so a scene, layout or library
 * change can be recorded with no program. On PostgreSQL it applies to an empty database, and to a
 * database with records, which keep their programId. It runs when
 * ALCANTARA_MIGRATION_TEST_DATABASE_URL names a server the test may create databases on.
 */
const serverUrl = process.env.ALCANTARA_MIGRATION_TEST_DATABASE_URL;
const migrationName = '20261124010000_operator_change_library';
const backend = join(__dirname, '..', '..');
const migrationsDir = join(backend, 'prisma', 'migrations');

/**
 * Deploys the migrations before this one, from a scratch copy: the shared migrations folder is
 * never moved, so specs running at the same time cannot see a partial folder, and a later migration
 * that alters this table cannot run before the table exists.
 */
function deployBefore(databaseUrl: string): void {
  const scratch = mkdtempSync(join(backend, '.migrations-before-'));
  try {
    const target = join(scratch, 'migrations');
    mkdirSync(target);
    cpSync(
      join(migrationsDir, 'migration_lock.toml'),
      join(target, 'migration_lock.toml'),
    );
    for (const entry of readdirSync(migrationsDir)) {
      if (entry !== 'migration_lock.toml' && entry < migrationName) {
        cpSync(join(migrationsDir, entry), join(target, entry), {
          recursive: true,
        });
      }
    }
    const config = join(scratch, 'prisma.config.ts');
    writeFileSync(
      config,
      `import { defineConfig } from 'prisma/config';
export default defineConfig({
  schema: ${JSON.stringify(join(backend, 'prisma', 'schema.prisma'))},
  migrations: { path: ${JSON.stringify(target)} },
  datasource: { url: process.env.DATABASE_URL as string },
});
`,
    );
    execFileSync('npx', ['prisma', 'migrate', 'deploy', '--config', config], {
      cwd: backend,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function withDatabase(name: string): string {
  const url = new URL(serverUrl as string);
  url.pathname = `/${name}`;
  return url.toString();
}

async function createDatabase(name: string): Promise<void> {
  const admin = new Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}

function deploy(databaseUrl: string): void {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: backend,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}

async function programIdNullable(databaseUrl: string): Promise<string> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'OperatorChangeRecord' AND column_name = 'programId'`,
    );
    return result.rows[0].is_nullable;
  } finally {
    await client.end();
  }
}

const describeWithServer = serverUrl ? describe : describe.skip;

// Each case deploys every migration to a fresh database, which takes longer than the default 5 s under a full run.
jest.setTimeout(120_000);

describeWithServer('OperatorChangeRecord library migration', () => {
  it('applies to an empty database and lets a record have no program', async () => {
    const name = 'operator_change_library_empty';
    await createDatabase(name);
    deploy(withDatabase(name));
    expect(await programIdNullable(withDatabase(name))).toBe('YES');
  });

  it('applies to a database with records, which keep their program', async () => {
    const name = 'operator_change_library_rows';
    await createDatabase(name);
    // The state before this change: every migration before this one.
    deployBefore(withDatabase(name));
    expect(await programIdNullable(withDatabase(name))).toBe('NO');

    const client = new Client({ connectionString: withDatabase(name) });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO "OperatorChangeRecord" ("id", "programId", "via", "capability", "summary")
         VALUES ('fixture-radio', 'fixture-main', 'mcp', 'radio_update_settings', '{}')`,
      );
    } finally {
      await client.end();
    }

    deploy(withDatabase(name));
    expect(await programIdNullable(withDatabase(name))).toBe('YES');
    const after = new Client({ connectionString: withDatabase(name) });
    await after.connect();
    try {
      await after.query(
        `INSERT INTO "OperatorChangeRecord" ("id", "programId", "via", "capability", "summary")
         VALUES ('fixture-library', NULL, 'console', 'stingers.update', '{}')`,
      );
      const rows = await after.query(
        `SELECT "id", "programId" FROM "OperatorChangeRecord" ORDER BY "id"`,
      );
      expect(rows.rows).toEqual([
        { id: 'fixture-library', programId: null },
        { id: 'fixture-radio', programId: 'fixture-main' },
      ]);
    } finally {
      await after.end();
    }
  });
});
