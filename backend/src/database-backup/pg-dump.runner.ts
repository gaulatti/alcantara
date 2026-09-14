import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { DatabaseDumpRunner } from './database-backup.contracts';

type SpawnProcess = typeof spawn;

interface LibpqConnection {
  environment: NodeJS.ProcessEnv;
  passwordFileContents: string;
}

const CONNECTION_ENVIRONMENT_KEYS = [
  'DATABASE_URL',
  'PGDATABASE',
  'PGHOST',
  'PGPASSWORD',
  'PGPASSFILE',
  'PGPORT',
  'PGSERVICE',
  'PGSSLMODE',
  'PGSSLROOTCERT',
  'PGUSER',
] as const;

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error('Database backup configuration is malformed');
  }
}

function safePassfileField(value: string): string {
  if (/\r|\n/.test(value)) {
    throw new Error('Database backup configuration is malformed');
  }
  return value.replace(/([\\:])/g, '\\$1');
}

export function libpqConnectionFromDatabaseUrl(
  databaseUrl: string,
): LibpqConnection {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('Database backup configuration is malformed');
  }

  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    !url.pathname.slice(1)
  ) {
    throw new Error('Database backup configuration is malformed');
  }

  const host = decoded(url.hostname);
  const port = url.port || '5432';
  const user = decoded(url.username);
  const password = decoded(url.password);
  const database = decoded(url.pathname.slice(1));
  const environment: NodeJS.ProcessEnv = {
    PGHOST: host,
    PGPORT: port,
    PGUSER: user,
    PGDATABASE: database,
  };

  const sslMode = url.searchParams.get('sslmode');
  const sslRootCert = url.searchParams.get('sslrootcert');
  if (sslMode) environment.PGSSLMODE = sslMode;
  if (sslRootCert) environment.PGSSLROOTCERT = sslRootCert;

  return {
    environment,
    passwordFileContents: [host, port, database, user, password]
      .map(safePassfileField)
      .join(':'),
  };
}

export class PgDumpRunner implements DatabaseDumpRunner {
  constructor(private readonly spawnProcess: SpawnProcess = spawn) {}

  async dump(
    databaseUrl: string,
    outputPath: string,
    workingDirectory: string,
  ): Promise<void> {
    const connection = libpqConnectionFromDatabaseUrl(databaseUrl);
    const passwordFile = join(workingDirectory, '.pgpass');
    await writeFile(passwordFile, `${connection.passwordFileContents}\n`, {
      mode: 0o600,
    });

    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const key of CONNECTION_ENVIRONMENT_KEYS) delete environment[key];
    Object.assign(environment, connection.environment, {
      PGPASSFILE: passwordFile,
    });

    const child = this.spawnProcess(
      'pg_dump',
      ['--no-owner', '--no-privileges', '--no-password'],
      {
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    child.stderr.resume();
    const processCompletion = new Promise<void>((resolve, reject) => {
      child.once('error', () => {
        reject(new Error('PostgreSQL backup process could not start'));
      });
      child.once('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('PostgreSQL backup process failed'));
      });
    });

    try {
      await Promise.all([
        pipeline(
          child.stdout,
          createGzip(),
          createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }),
        ),
        processCompletion,
      ]);
    } catch {
      if (!child.killed) child.kill();
      throw new Error('PostgreSQL backup failed');
    }
  }
}
