import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { PgDumpRunner, libpqConnectionFromDatabaseUrl } from './pg-dump.runner';

describe('PgDumpRunner', () => {
  it('maps the database URL to libpq fields and escapes the password file', () => {
    const connection = libpqConnectionFromDatabaseUrl(
      'postgresql://backup-user:p%3Aa%5Css@db.internal:5433/alcantara?schema=public&sslmode=verify-full&sslrootcert=%2Fapp%2Fcerts%2Fglobal.pem',
    );

    expect(connection.environment).toEqual({
      PGHOST: 'db.internal',
      PGPORT: '5433',
      PGUSER: 'backup-user',
      PGDATABASE: 'alcantara',
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: '/app/certs/global.pem',
    });
    expect(connection.passwordFileContents).toBe(
      'db.internal:5433:alcantara:backup-user:p\\:a\\\\ss',
    );
  });

  it('streams a compressed dump without putting credentials in arguments or inherited URL variables', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pg-dump-runner-'));
    const outputPath = join(directory, 'backup.sql.gz');
    let invocation:
      | { command: string; arguments: string[]; environment: NodeJS.ProcessEnv }
      | undefined;
    let passfileAtSpawn = '';
    const spawnProcess = ((
      command: string,
      args: string[],
      options: { env: NodeJS.ProcessEnv },
    ) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        killed: boolean;
        kill: jest.Mock;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = jest.fn(() => {
        child.killed = true;
      });
      invocation = { command, arguments: args, environment: options.env };
      passfileAtSpawn = readFileSync(options.env.PGPASSFILE!, 'utf8');
      process.nextTick(() => {
        child.stdout.end('CREATE TABLE example (id integer);\n');
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    }) as never;
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalPgPassword = process.env.PGPASSWORD;
    process.env.DATABASE_URL = 'postgresql://inherited:leak@wrong.invalid/db';
    process.env.PGPASSWORD = 'inherited-secret';

    try {
      const runner = new PgDumpRunner(spawnProcess);
      await runner.dump(
        'postgresql://backup-user:p%3Aa%5Css@db.internal/alcantara',
        outputPath,
        directory,
      );

      expect(invocation?.command).toBe('pg_dump');
      expect(invocation?.arguments).toEqual([
        '--no-owner',
        '--no-privileges',
        '--no-password',
      ]);
      expect(invocation?.environment.DATABASE_URL).toBeUndefined();
      expect(invocation?.environment.PGPASSWORD).toBeUndefined();
      expect(invocation?.environment.PGDATABASE).toBe('alcantara');
      expect(passfileAtSpawn).toBe(
        'db.internal:5432:alcantara:backup-user:p\\:a\\\\ss\n',
      );
      expect(gunzipSync(readFileSync(outputPath)).toString()).toBe(
        'CREATE TABLE example (id integer);\n',
      );
      expect(existsSync(join(directory, '.pgpass'))).toBe(true);
    } finally {
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (originalPgPassword === undefined) delete process.env.PGPASSWORD;
      else process.env.PGPASSWORD = originalPgPassword;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects malformed connection URLs without echoing them', () => {
    expect(() => libpqConnectionFromDatabaseUrl('not-a-database-url')).toThrow(
      'Database backup configuration is malformed',
    );
  });
});
