#!/usr/bin/env node
// gaulatti/alcantara#122: give the operator change records written with no team their program's team.
//
// Until a0cb3a43 every operator change record was written with teamId NULL. This sets each such record's teamId from
// its program's Program row, where the record names a program and that program has a team. A record with no program
// (a scene, a layout, the library) or whose program has no team keeps NULL, and is counted.
//
//   node scripts/backfill-change-record-teams.cjs --allow-remote            # dry run (default): what it would set
//   node scripts/backfill-change-record-teams.cjs --allow-remote --apply    # sets them, in one transaction
//
// With --station-team, it gives instead the records that name no program (a scene, a layout, the library) the
// station's team, as the recorder does for such a change since a0cb3a43. The team is the running backend's own
// POMPEII_TEAM_ID, never a value typed on the command line, and it is refused unless some program belongs to it:
//
//   node scripts/backfill-change-record-teams.cjs --allow-remote --station-team            # dry run
//   node scripts/backfill-change-record-teams.cjs --allow-remote --station-team --apply    # sets them
//
// The database is the backend's: ARAUCO_SECRET_ID resolves it (as in the backend container), else DATABASE_URL names
// it. A host other than localhost, 127.0.0.1 or postgres is refused unless --allow-remote is given. Only counts are
// printed, never a record, a program id or a team.

/** Records with no team, split by what the backfill can do for them. */
const COUNT_SQL = `
  SELECT
    count(*) FILTER (WHERE p."teamId" IS NOT NULL)::int AS settable,
    count(*) FILTER (WHERE r."programId" IS NULL)::int AS no_program,
    count(*) FILTER (WHERE r."programId" IS NOT NULL AND p."teamId" IS NULL)::int AS program_without_team
  FROM "OperatorChangeRecord" r
  LEFT JOIN "Program" p ON p."programId" = r."programId"
  WHERE r."teamId" IS NULL`;

/** Sets the program's team on each settable record; never touches a record that already has a team. */
const UPDATE_SQL = `
  UPDATE "OperatorChangeRecord" r
  SET "teamId" = p."teamId"
  FROM "Program" p
  WHERE r."teamId" IS NULL AND r."programId" = p."programId" AND p."teamId" IS NOT NULL`;

/** Records that name no program and have no team: what --station-team sets. */
const STATION_COUNT_SQL = `
  SELECT count(*)::int AS settable
  FROM "OperatorChangeRecord"
  WHERE "teamId" IS NULL AND "programId" IS NULL`;

/** Gives the station team to each record that names no program and has none; never touches another record. */
const STATION_UPDATE_SQL = `
  UPDATE "OperatorChangeRecord"
  SET "teamId" = $1
  WHERE "teamId" IS NULL AND "programId" IS NULL`;

/**
 * The station team for --station-team: the backend's own POMPEII_TEAM_ID (as PompeiiService reads it), or null when
 * the option is absent. Refused unless it is a positive integer.
 */
function stationTeamOf(argv, environment = process.env) {
  if (!argv.includes('--station-team')) return null;
  const raw = (environment.POMPEII_TEAM_ID ?? '').trim();
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value <= 0) throw new Error('--station-team needs a positive POMPEII_TEAM_ID; nothing written');
  return value;
}

/** Whether any program belongs to the team: a station team no program has is refused. */
const TEAM_HAS_PROGRAM_SQL = 'SELECT count(*)::int AS programs FROM "Program" WHERE "teamId" = $1';

/** The --station-team backfill on a pg client, with the same dry run, count check and rollback. */
async function backfillStation({ db, apply, team, say }) {
  await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  try {
    const {
      rows: [owned],
    } = await db.query(TEAM_HAS_PROGRAM_SQL, [team]);
    if (owned.programs === 0) throw new Error('no program belongs to the station team; nothing written');
    const {
      rows: [counts],
    } = await db.query(STATION_COUNT_SQL);
    say(`records with no program and no team: ${counts.settable}`);
    if (!apply) {
      await db.query('ROLLBACK');
      say(`dry run: nothing written; --apply would give ${counts.settable} the station team`);
      return { settable: counts.settable, updated: 0 };
    }
    const { rowCount } = await db.query(STATION_UPDATE_SQL, [team]);
    if (rowCount !== counts.settable) throw new Error(`would set ${rowCount}, counted ${counts.settable}; nothing written`);
    await db.query('COMMIT');
    say(`applied: gave ${rowCount} the station team`);
    return { settable: counts.settable, updated: rowCount };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

function hostAllowed(url, allowRemote) {
  const host = new URL(url).hostname;
  return allowRemote || ['localhost', '127.0.0.1', 'postgres'].includes(host);
}

/**
 * The backfill on a pg client. `say` takes each printed line. Returns the counts. A dry run writes nothing; an apply
 * updates in one transaction and fails, rolling back, if it would set a different number of records than it counted.
 */
async function backfill({ db, apply, say }) {
  await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  try {
    const {
      rows: [counts],
    } = await db.query(COUNT_SQL);
    say(`records with no team: ${counts.settable + counts.no_program + counts.program_without_team}`);
    say(`  settable from their program's team: ${counts.settable}`);
    say(`  no program (keep no team): ${counts.no_program}`);
    say(`  program without a team (keep no team): ${counts.program_without_team}`);
    if (!apply) {
      await db.query('ROLLBACK');
      say(`dry run: nothing written; --apply would set ${counts.settable}`);
      return { ...counts, updated: 0 };
    }
    const { rowCount } = await db.query(UPDATE_SQL);
    if (rowCount !== counts.settable) throw new Error(`would set ${rowCount}, counted ${counts.settable}; nothing written`);
    await db.query('COMMIT');
    say(`applied: set ${rowCount}`);
    return { ...counts, updated: rowCount };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const team = stationTeamOf(argv);
  const { loadDatabaseSecret } = require('../dist/src/config/database-secrets.js');
  await loadDatabaseSecret();
  const url = process.env.DATABASE_URL;
  if (!hostAllowed(url, argv.includes('--allow-remote'))) {
    throw new Error(`refusing host ${new URL(url).hostname}; pass --allow-remote only for the database you mean`);
  }
  const { Client } = require('pg');
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const say = (line) => console.log(line);
    if (team === null) await backfill({ db, apply, say });
    else await backfillStation({ db, apply, team, say });
  } finally {
    await db.end();
  }
}

module.exports = { backfill, backfillStation, stationTeamOf, hostAllowed, COUNT_SQL, UPDATE_SQL, STATION_COUNT_SQL, STATION_UPDATE_SQL, TEAM_HAS_PROGRAM_SQL };

if (require.main === module) {
  main().catch((error) => {
    // Messages carry counts and host names only.
    console.error(error instanceof Error ? error.message : 'backfill failed');
    process.exitCode = 1;
  });
}
