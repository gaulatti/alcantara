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
 * The as-run flight cue migration (gaulatti/alcantara#726) on PostgreSQL: it applies to an empty
 * database, and to one with as-run rows, which keep their values and read null in the new columns.
 * It runs when ALCANTARA_MIGRATION_TEST_DATABASE_URL names a server the test may create databases on.
 */
const serverUrl = process.env.ALCANTARA_MIGRATION_TEST_DATABASE_URL;
const migrationName = '20261126020000_as_run_flight_cue';
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

async function columns(databaseUrl: string): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'AsRunRecord' AND column_name IN ('flightSequenceId', 'flightCueId') ORDER BY column_name`,
    );
    return result.rows.map((row) => row.column_name);
  } finally {
    await client.end();
  }
}

const describeWithServer = serverUrl ? describe : describe.skip;

// Each case deploys every migration to a fresh database, which takes longer than the default 5 s under a full run.
jest.setTimeout(120_000);

describeWithServer('as-run flight cue migration (#726)', () => {
  it('applies to an empty database and adds both columns', async () => {
    const name = 'as_run_flight_cue_empty';
    await createDatabase(name);
    deploy(withDatabase(name));
    expect(await columns(withDatabase(name))).toEqual([
      'flightCueId',
      'flightSequenceId',
    ]);
  });

  it('applies to a database with as-run rows, which keep their values', async () => {
    const name = 'as_run_flight_cue_rows';
    await createDatabase(name);
    deployBefore(withDatabase(name));
    expect(await columns(withDatabase(name))).toEqual([]);

    const before = new Client({ connectionString: withDatabase(name) });
    await before.connect();
    try {
      await before.query(
        `INSERT INTO "AsRunRecord" ("programId", "songId", "state", "endReason", "at") VALUES ('fixture-radio', 7, 'not-aired', 'engine_unavailable', '2026-11-26T13:00:00Z')`,
      );
    } finally {
      await before.end();
    }

    deploy(withDatabase(name));
    const after = new Client({ connectionString: withDatabase(name) });
    await after.connect();
    try {
      const rows = await after.query(
        `SELECT "programId", "songId", "state", "endReason", "flightSequenceId", "flightCueId" FROM "AsRunRecord"`,
      );
      expect(rows.rows).toEqual([
        {
          programId: 'fixture-radio',
          songId: 7,
          state: 'not-aired',
          endReason: 'engine_unavailable',
          flightSequenceId: null,
          flightCueId: null,
        },
      ]);
    } finally {
      await after.end();
    }
  });
});
