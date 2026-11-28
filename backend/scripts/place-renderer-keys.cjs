#!/usr/bin/env node
// gaulatti/alcantara#884: give each program's machines its own renderer key, with no key ever shown.
//
// Two steps joined by a pipe, so a clear key only ever travels on that pipe:
//
//   issue  runs where the database is (the backend container): for each --program it issues a key when the program has
//          none, or replaces it with --rotate, and writes one JSON line per program to stdout. It refuses to write keys
//          to a terminal.
//   write  runs where the runtime secret can be written (an operator shell with AWS credentials, in the backend image):
//          it reads those lines and merges the keys into the secret's webrtcProgramKeys, keeping every other field.
//
//   ssh <backend> "docker exec -i alcantara-backend node scripts/place-renderer-keys.cjs issue --allow-remote --program a" \
//     | docker run --rm -i -e AWS_REGION -e ALCANTARA_CONFIG_SECRET_ID … <image> node scripts/place-renderer-keys.cjs write
//
// --dry-run on either step changes nothing and says what it would do. An existing key is kept unless --rotate is given:
// a kept key has no clear value to place, so that program's machines keep the key they already have or the shared key.
// A rotation stops every machine holding the old key at once; one used in the last 15 minutes is warned about.
// The database is the backend's: ARAUCO_SECRET_ID resolves it (as in the backend container), else DATABASE_URL names it.
// A host other than localhost, 127.0.0.1 or postgres is refused unless --allow-remote is given. Only program ids, versions and outcomes are printed, never a key, a hash or the secret.

const { createHash, randomBytes, randomUUID } = require('node:crypto');

const KEY_PREFIX = 'alrk_';
const KEY_SHAPE = /^alrk_[A-Za-z0-9_-]{43}$/;
const PROGRAM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** A key used this recently is likely held by a running machine, which a rotation stops. */
const RECENT_USE_MS = 15 * 60_000;

/** The stored form of a key, as the backend checks it (renderer-key.service hashRendererKey). */
function hashRendererKey(key) {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

function newRendererKey() {
  return `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

function hostAllowed(url, allowRemote) {
  const host = new URL(url).hostname;
  return allowRemote || ['localhost', '127.0.0.1', 'postgres'].includes(host);
}

function parseArgs(argv) {
  const [step, ...rest] = argv;
  const programs = [];
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] !== '--program') continue;
    const programId = rest[index + 1];
    if (!programId || !PROGRAM_ID.test(programId)) throw new Error('--program needs a program id');
    if (!programs.includes(programId)) programs.push(programId);
  }
  return {
    step,
    programs,
    rotate: rest.includes('--rotate'),
    dryRun: rest.includes('--dry-run'),
    allowRemote: rest.includes('--allow-remote'),
  };
}

/**
 * Step one. `db.query(text, values)` is a pg client; `say` takes the human lines (stderr), `emit` the key lines (the
 * pipe). Returns how many programs could not be handled.
 */
async function issueKeys({ db, programs, rotate, dryRun, say, emit, now = () => Date.now(), newKey = newRendererKey }) {
  let failures = 0;
  for (const programId of programs) {
    const {
      rows: [row],
    } = await db.query(
      'SELECT ps.id, k.version, k."lastUsedAt" FROM "ProgramState" ps LEFT JOIN "ProgramRendererKey" k ON k."programStateId" = ps.id WHERE ps."programId" = $1',
      [programId],
    );
    if (!row) {
      say(`${programId}: no such program; nothing changed`);
      failures++;
      continue;
    }
    const exists = row.version !== null && row.version !== undefined;
    if (exists && !rotate) {
      say(`${programId}: kept, version ${row.version} (pass --rotate to replace it)`);
      emit({ programId, version: row.version, kept: true });
      continue;
    }
    const nextVersion = exists ? row.version + 1 : 1;
    if (exists && row.lastUsedAt && now() - new Date(row.lastUsedAt).getTime() < RECENT_USE_MS) {
      say(
        `${programId}: warning: version ${row.version} was used in the last 15 minutes; the machines holding it (the pilot, a runner, a worker) stop until they get version ${nextVersion}`,
      );
    }
    if (dryRun) {
      say(`${programId}: would ${exists ? 'rotate' : 'issue'} version ${nextVersion}`);
      continue;
    }
    const key = newKey();
    await db.query('BEGIN');
    try {
      const {
        rows: [stored],
      } = await db.query(
        `INSERT INTO "ProgramRendererKey" ("programStateId", "keyHash", "version", "createdAt", "rotatedAt", "lastUsedAt")
         VALUES ($1, $2, 1, now(), now(), NULL)
         ON CONFLICT ("programStateId") DO UPDATE
           SET "keyHash" = EXCLUDED."keyHash", "version" = "ProgramRendererKey"."version" + 1, "rotatedAt" = now(), "lastUsedAt" = NULL
         RETURNING "version"`,
        [row.id, hashRendererKey(key)],
      );
      await db.query(
        'INSERT INTO "OperatorChangeRecord" ("id", "teamId", "programId", "principal", "via", "client", "capability", "summary") VALUES ($1, NULL, $2, NULL, $3, $4, $5, $6)',
        [
          randomUUID(),
          programId,
          'script',
          'place-renderer-keys',
          'program.rotate-renderer-key',
          JSON.stringify({
            target: { kind: 'program', id: programId },
            changed: ['rendererKey', 'version'],
            before: { version: exists ? row.version : null },
            after: { version: stored.version },
          }),
        ],
      );
      await db.query('COMMIT');
      say(`${programId}: ${exists ? 'rotated' : 'issued'} version ${stored.version}`);
      emit({ programId, version: stored.version, key });
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  }
  return failures;
}

/** The key lines from step one, refusing anything else. */
function readKeyLines(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error('the input has a line that is not a key line; nothing written');
    }
    const valid =
      entry &&
      typeof entry.programId === 'string' &&
      PROGRAM_ID.test(entry.programId) &&
      Number.isInteger(entry.version) &&
      (entry.kept === true ? entry.key === undefined : typeof entry.key === 'string' && KEY_SHAPE.test(entry.key));
    if (!valid) throw new Error('the input has a line that is not a key line; nothing written');
    entries.push(entry);
  }
  return entries;
}

/**
 * Step two. `getSecret()` answers the secret string and `putSecret(text)` writes it; `validate(text)` is the runtime
 * secret contract. `report` takes the result lines (stdout), `say` the notes (stderr). Neither ever gets a key.
 */
async function writeKeys({ input, dryRun, getSecret, putSecret, validate, report, say }) {
  const entries = readKeyLines(input);
  if (!entries.length) {
    if (dryRun) {
      report('dry run: nothing to write');
      return;
    }
    throw new Error('no key lines on the input; nothing written');
  }
  const issued = entries.filter((entry) => !entry.kept);
  try {
    await placeKeys({ entries, issued, dryRun, getSecret, putSecret, validate, report, say });
  } catch (error) {
    // Keys the issue step made are in the database but no machine holds them: say how to recover.
    if (issued.length && !dryRun && error instanceof Error) error.unplaced = true;
    throw error;
  }
}

async function placeKeys({ entries, issued, dryRun, getSecret, putSecret, validate, report, say }) {
  const payload = JSON.parse(await getSecret());
  const placed = payload.webrtcProgramKeys ?? {};
  for (const entry of entries.filter((entry) => entry.kept)) {
    report(
      placed[entry.programId]
        ? `${entry.programId}: version ${entry.version}, kept, already placed`
        : `${entry.programId}: version ${entry.version}, kept, holder uses shared`,
    );
  }
  if (!issued.length) return;
  const merged = { ...payload, webrtcProgramKeys: { ...placed } };
  for (const entry of issued) merged.webrtcProgramKeys[entry.programId] = entry.key;
  const text = JSON.stringify(merged);
  validate(text);
  if (dryRun) {
    for (const entry of issued) report(`${entry.programId}: version ${entry.version}, would be written`);
    say('dry run: the secret is unchanged, and the issued keys are not placed');
    return;
  }
  await putSecret(text);
  for (const entry of issued) report(`${entry.programId}: version ${entry.version}, written`);
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 1_000_000) throw new Error('the input is too large; nothing written');
  }
  return text;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const say = (line) => process.stderr.write(`${line}\n`);
  if (options.step === 'issue') {
    if (!options.programs.length) throw new Error('issue needs at least one --program');
    if (!options.dryRun && process.stdout.isTTY) {
      throw new Error('refusing to write keys to a terminal: pipe issue into write');
    }
    // ARAUCO_SECRET_ID (as in the backend container) resolves DATABASE_URL, as every other production script does.
    const { loadDatabaseSecret } = require('../dist/src/config/database-secrets.js');
    await loadDatabaseSecret();
    const url = process.env.DATABASE_URL;
    if (!hostAllowed(url, options.allowRemote)) {
      throw new Error(`refusing to write to host ${new URL(url).hostname}; pass --allow-remote only for the database you mean`);
    }
    const { Client } = require('pg');
    const db = new Client({ connectionString: url });
    await db.connect();
    try {
      const failures = await issueKeys({
        db,
        ...options,
        say,
        emit: (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`),
      });
      if (failures) process.exitCode = 1;
    } finally {
      await db.end();
    }
    return;
  }
  if (options.step === 'write') {
    const secretId = process.env.ALCANTARA_CONFIG_SECRET_ID?.trim();
    const region = process.env.AWS_REGION?.trim();
    if (!secretId || !region) throw new Error('ALCANTARA_CONFIG_SECRET_ID and AWS_REGION are required');
    const { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');
    const { parseRuntimeSecretPayload } = require('../src/config/runtime-secret-contract.js');
    const client = new SecretsManagerClient({ region });
    try {
      await writeKeys({
        input: await readStdin(),
        dryRun: options.dryRun,
        getSecret: async () => (await client.send(new GetSecretValueCommand({ SecretId: secretId }))).SecretString,
        putSecret: async (text) => {
          await client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: text }));
        },
        validate: (text) => parseRuntimeSecretPayload(text),
        report: (line) => process.stdout.write(`${line}\n`),
        say,
      });
    } catch (error) {
      if (error && error.unplaced)
        say('write failed: a key issued or rotated by the issue step is not placed. Run both steps again with --rotate');
      throw error;
    }
    return;
  }
  throw new Error('usage: place-renderer-keys.cjs issue --program <id> [--program <id>] [--rotate] [--dry-run] [--allow-remote] | write [--dry-run]');
}

module.exports = { hashRendererKey, newRendererKey, hostAllowed, parseArgs, issueKeys, readKeyLines, writeKeys, RECENT_USE_MS };

if (require.main === module) {
  main().catch((error) => {
    // Messages name programs and fields, never a key or the secret.
    console.error(error instanceof Error ? error.message : 'place-renderer-keys failed');
    process.exitCode = 1;
  });
}
