import { spawnSync } from 'node:child_process';

import pg from 'pg';

const { Client } = pg;
const baselineMigration = '0_postgresql_baseline';
const requiredTables = [
  'BroadcastSettings',
  'FlightSequence',
  'Instant',
  'Layout',
  'Media',
  'MediaGroup',
  'MediaGroupItem',
  'NowPlayingConsumer',
  'ProgramMediaGroup',
  'ProgramScene',
  'ProgramState',
  'ProgramStinger',
  'RadioSettings',
  'Scene',
  'Song',
  'Stinger',
];

function runPrisma(args) {
  const result = spawnSync('pnpm', ['exec', 'prisma', ...args], {
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function inspectDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to deploy migrations');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const historyResult = await client.query(
      `SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS "exists"`,
    );

    if (historyResult.rows[0]?.exists) {
      return { needsBaseline: false };
    }

    const tablesResult = await client.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type = 'BASE TABLE'`,
    );
    const existingTables = new Set(
      tablesResult.rows.map(({ table_name }) => table_name),
    );

    if (existingTables.size === 0) {
      return { needsBaseline: false };
    }

    const missingTables = requiredTables.filter(
      (tableName) => !existingTables.has(tableName),
    );
    if (missingTables.length > 0) {
      throw new Error(
        `Refusing to baseline an unrecognized database; missing tables: ${missingTables.join(
          ', ',
        )}`,
      );
    }

    return { needsBaseline: true };
  } finally {
    await client.end();
  }
}

const { needsBaseline } = await inspectDatabase();

if (needsBaseline) {
  console.log(
    `Recognized the existing Alcantara schema; recording ${baselineMigration} as applied.`,
  );
  runPrisma(['migrate', 'resolve', '--applied', baselineMigration]);
}

runPrisma(['migrate', 'deploy']);
