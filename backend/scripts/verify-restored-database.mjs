import pg from 'pg';
import { loadDatabaseSecret } from '../dist/src/config/database-secrets.js';

await loadDatabaseSecret();
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const table = await client.query(
    `SELECT to_regclass('public."ProgramState"') AS name`,
  );
  if (!table.rows[0]?.name) {
    throw new Error('Arauco has not been restored: ProgramState is absent');
  }
  const data = await client.query(
    'SELECT count(*)::int AS count FROM "ProgramState"',
  );
  if ((data.rows[0]?.count ?? 0) < 1) {
    throw new Error('Arauco has not been restored: ProgramState is empty');
  }
} finally {
  await client.end();
}
