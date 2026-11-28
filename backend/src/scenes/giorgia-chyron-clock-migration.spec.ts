import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Client as UntypedPgClient } from 'pg';

// pg ships without types in this package set. These specs use only the calls below, so this is the typed view of
// the client they get; it is a cast, not a new behaviour.
interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}
const Client = UntypedPgClient as unknown as new (config: {
  connectionString: string | undefined;
}) => PgClient;

/**
 * The retired chyron and clock migration on PostgreSQL: layouts that list them list the Giorgia ids in place, their
 * scenes carry the stored props over under the Giorgia keys, everything else stays as it was, and a second run
 * changes nothing. It runs when ALCANTARA_MIGRATION_TEST_DATABASE_URL names a server the test may create databases on.
 */
const serverUrl = process.env.ALCANTARA_MIGRATION_TEST_DATABASE_URL;
const migrationName = '20261127020000_giorgia_chyron_clock';
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

const describeWithServer = serverUrl ? describe : describe.skip;

jest.setTimeout(120_000);

const chyron = {
  show: false,
  textSequence: { mode: 'manual', items: [] },
  ctaSequence: { mode: 'manual', items: [] },
};
const clock = {
  showWorldClocks: false,
  showLogo: false,
  showPlaybackProgress: true,
};

describeWithServer('retired chyron and clock migration', () => {
  it('moves the layouts and their scene props to the Giorgia ids, leaves the rest, and is idempotent', async () => {
    const name = 'giorgia_chyron_clock_rows';
    await createDatabase(name);
    deployBefore(withDatabase(name));
    const client = new Client({ connectionString: withDatabase(name) });
    await client.connect();
    try {
      const layout = async (layoutName: string, componentType: string) =>
        (
          await client.query(
            `INSERT INTO "Layout" (name, "componentType", settings, "updatedAt") VALUES ($1, $2, '{}', now()) RETURNING id`,
            [layoutName, componentType],
          )
        ).rows[0].id as number;
      const scene = async (
        sceneName: string,
        layoutId: number,
        metadata: string | null,
      ) =>
        (
          await client.query(
            `INSERT INTO "Scene" (name, "layoutId", metadata, "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`,
            [sceneName, layoutId, metadata],
          )
        ).rows[0].id as number;

      const plates = await layout(
        'fixture-plates',
        'cronica-background, modoitaliano-chyron,cronica-chyron,modoitaliano-clock',
      );
      const tournament = await layout(
        'fixture-tournament',
        'modoitaliano-clock,modoitaliano-bracket',
      );
      const both = await layout(
        'fixture-both',
        'modoitaliano-clock,slideshow,modoitaliano-giorgia-clock',
      );
      const current = await layout(
        'fixture-current',
        'modoitaliano-giorgia-clock,modoitaliano-giorgia-chyron',
      );
      const platesScene = await scene(
        'fixture-plates-scene',
        plates,
        JSON.stringify({
          'modoitaliano-chyron': chyron,
          'modoitaliano-clock': clock,
          'cronica-chyron': { text: 'kept' },
        }),
      );
      const bothScene = await scene(
        'fixture-both-scene',
        both,
        JSON.stringify({
          'modoitaliano-clock': clock,
          'modoitaliano-giorgia-clock': { showLogo: true },
        }),
      );
      const brokenScene = await scene(
        'fixture-broken-scene',
        tournament,
        'not json',
      );
      const emptyScene = await scene('fixture-empty-scene', tournament, null);
      const leftover = JSON.stringify({ 'modoitaliano-clock': clock });
      const currentScene = await scene(
        'fixture-current-scene',
        current,
        leftover,
      );

      deploy(withDatabase(name));

      const layouts = async () =>
        Object.fromEntries(
          (
            await client.query<{ id: number; componentType: string }>(
              `SELECT id, "componentType" FROM "Layout" WHERE name LIKE 'fixture-%'`,
            )
          ).rows.map((row) => [row.id, row.componentType]),
        );
      const metadata = async (id: number) =>
        (
          await client.query<{ metadata: string | null }>(
            `SELECT metadata FROM "Scene" WHERE id = $1`,
            [id],
          )
        ).rows[0].metadata;

      expect(await layouts()).toEqual({
        [plates]:
          'cronica-background,modoitaliano-giorgia-chyron,cronica-chyron,modoitaliano-giorgia-clock',
        [tournament]: 'modoitaliano-giorgia-clock,modoitaliano-bracket',
        [both]: 'modoitaliano-giorgia-clock,slideshow',
        [current]: 'modoitaliano-giorgia-clock,modoitaliano-giorgia-chyron',
      });
      expect(JSON.parse((await metadata(platesScene)) as string)).toEqual({
        'modoitaliano-chyron': chyron,
        'modoitaliano-clock': clock,
        'cronica-chyron': { text: 'kept' },
        'modoitaliano-giorgia-chyron': chyron,
        'modoitaliano-giorgia-clock': clock,
      });
      // The props on air (the retired key the operator edited) win over an older Giorgia key.
      expect(
        (
          JSON.parse((await metadata(bothScene)) as string) as Record<
            string,
            unknown
          >
        )['modoitaliano-giorgia-clock'],
      ).toEqual(clock);
      expect(await metadata(brokenScene)).toBe('not json');
      expect(await metadata(emptyScene)).toBeNull();
      // A Giorgia layout is not touched, even with a retired key left in its scene.
      expect(await metadata(currentScene)).toBe(leftover);

      const before = (
        await client.query(
          `SELECT s.id, s.metadata, l."componentType", s."updatedAt" AS a, l."updatedAt" AS b FROM "Scene" s JOIN "Layout" l ON l.id = s."layoutId" ORDER BY s.id`,
        )
      ).rows;
      const sql = readFileSync(
        join(migrationsDir, migrationName, 'migration.sql'),
        'utf8',
      );
      await client.query(sql);
      const after = (
        await client.query(
          `SELECT s.id, s.metadata, l."componentType", s."updatedAt" AS a, l."updatedAt" AS b FROM "Scene" s JOIN "Layout" l ON l.id = s."layoutId" ORDER BY s.id`,
        )
      ).rows;
      expect(after).toEqual(before);
    } finally {
      await client.end();
    }
  });
});
