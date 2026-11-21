// gaulatti/alcantara#241: lists, read-only, the as-run rows a backend restart
// left wrong. Prints one line per finding; never writes. Usage:
//   node scripts/list-as-run-anomalies.mjs [--since=2026-08-25T00:00:00Z] [--program=<id>]
// Run after `npm run build` (it uses the compiled finder).
import pg from 'pg';
import { loadDatabaseSecret } from '../dist/src/config/database-secrets.js';
import { findAsRunAnomalies } from '../dist/src/as-run/as-run.anomalies.js';

const arg = (name) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
// The adoption code landed in cac3b74 (2026-08-25).
const since = new Date(arg('since') ?? '2026-08-25T00:00:00Z');
if (Number.isNaN(since.getTime())) throw new Error('--since must be a date');
const program = arg('program');

await loadDatabaseSecret();
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  // Read only, enforced by the database: any write in this session fails.
  await client.query('BEGIN READ ONLY');
  const result = await client.query(
    // "at" is TIMESTAMP(3) holding UTC wall time (Prisma's convention), so it
    // is read and compared as UTC text, never through the local time zone.
    `SELECT id, "programId", "songId", state, "playbackRequestId",
            to_char(at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
       FROM "AsRunRecord"
      WHERE at >= $1::timestamp AND ($2::text IS NULL OR "programId" = $2)
      ORDER BY "programId", at, id`,
    [since.toISOString().slice(0, 23).replace('T', ' '), program ?? null],
  );
  const found = findAsRunAnomalies(
    result.rows.map((r) => ({ ...r, at: new Date(r.at) })),
  );
  for (const a of found) {
    const base = `${a.kind} program=${a.programId} record=${a.recordId} play=${a.playbackRequestId} song=${a.songId ?? '-'} started=${a.startedAt.toISOString()}`;
    console.log(
      a.kind === 'unended'
        ? `${base} next_start=${a.nextStartAt.toISOString()}`
        : `${base} previous=${a.previousPlaybackRequestId} previous_ended=${a.previousEndedAt.toISOString()} overlap_s=${a.overlapSeconds.toFixed(1)}`,
    );
  }
  console.log(
    `as-run anomalies since ${since.toISOString()}: ${found.filter((a) => a.kind === 'unended').length} unended, ${found.filter((a) => a.kind === 'overlap').length} overlap, ${result.rows.length} rows read`,
  );
  await client.query('COMMIT');
} finally {
  await client.end();
}
