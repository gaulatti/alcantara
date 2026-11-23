import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const migrationDir = join(backend, 'prisma', 'migrations', migrationName);

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
    // Bring the database to the state before this change: every migration but this one.
    const scratch = mkdtempSync(join(tmpdir(), 'operator-change-'));
    try {
      renameSync(migrationDir, join(scratch, migrationName));
      deploy(withDatabase(name));
    } finally {
      renameSync(join(scratch, migrationName), migrationDir);
      rmSync(scratch, { recursive: true, force: true });
    }
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
