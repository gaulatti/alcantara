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
 * The OperatorChangeRecord migration (gaulatti/alcantara#236) on PostgreSQL: it applies to an empty
 * database, and it applies to a database that has rows, leaving them as they were. It runs when
 * ALCANTARA_MIGRATION_TEST_DATABASE_URL names a server the test may create databases on.
 */
const serverUrl = process.env.ALCANTARA_MIGRATION_TEST_DATABASE_URL;
const migrationName = '20261123150000_operator_change_record';
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

async function tableExists(
  databaseUrl: string,
  table: string,
): Promise<boolean> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    await client.end();
  }
}

const describeWithServer = serverUrl ? describe : describe.skip;

// Each case deploys every migration to a fresh database, which takes longer than the default 5 s under a full run.
jest.setTimeout(120_000);

describeWithServer('OperatorChangeRecord migration', () => {
  it('applies to an empty database and creates the table', async () => {
    const name = 'operator_change_empty';
    await createDatabase(name);
    deploy(withDatabase(name));
    expect(await tableExists(withDatabase(name), 'OperatorChangeRecord')).toBe(
      true,
    );
  });

  it('applies to a database with rows and leaves them as they were', async () => {
    const name = 'operator_change_rows';
    await createDatabase(name);
    // The state before this change: every migration before this one.
    deployBefore(withDatabase(name));
    expect(await tableExists(withDatabase(name), 'OperatorChangeRecord')).toBe(
      false,
    );

    const client = new Client({ connectionString: withDatabase(name) });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO "ProgramState" ("programId", "updatedAt") VALUES ('fixture-main', now())`,
      );
    } finally {
      await client.end();
    }

    deploy(withDatabase(name));
    const after = new Client({ connectionString: withDatabase(name) });
    await after.connect();
    try {
      const program = await after.query(
        `SELECT count(*)::int AS n FROM "ProgramState" WHERE "programId" = 'fixture-main'`,
      );
      const records = await after.query(
        `SELECT count(*)::int AS n FROM "OperatorChangeRecord"`,
      );
      expect(program.rows[0].n).toBe(1);
      expect(records.rows[0].n).toBe(0);
    } finally {
      await after.end();
    }
  });
});
