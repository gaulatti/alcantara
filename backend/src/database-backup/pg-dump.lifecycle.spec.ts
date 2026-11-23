import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { PgDumpRunner, libpqConnectionFromDatabaseUrl } from './pg-dump.runner';

describe('pg_dump process and libpq failure boundaries', () => {
  it.each([
    'https://user:secret@db.invalid/database',
    'postgresql:///database',
    'postgresql://db.invalid/database',
    'postgresql://user@db.invalid/',
    'postgresql://user:%ZZ@db.invalid/database',
    'postgresql://user:secret@db.invalid/data%ZZ',
    'postgresql://user:p%0Asecret@db.invalid/database',
    'postgresql://user%0Dname:secret@db.invalid/database',
    'postgresql://user:secret@db.invalid/data%0Abase',
  ])(
    'rejects malformed or passfile-injecting URL without leaking its values: %s',
    (url) => {
      expect(() => libpqConnectionFromDatabaseUrl(url)).toThrow(
        'Database backup configuration is malformed',
      );
    },
  );

  it('does not manufacture optional TLS settings when they are explicitly empty', () => {
    const connection = libpqConnectionFromDatabaseUrl(
      'postgres://user@db.invalid/database?sslmode=&sslrootcert=',
    );
    expect(connection.environment).toEqual({
      PGHOST: 'db.invalid',
      PGPORT: '5432',
      PGUSER: 'user',
      PGDATABASE: 'database',
    });
    expect(connection.passwordFileContents).toBe(
      'db.invalid:5432:database:user:',
    );
  });

  it.each([
    'spawn-error',
    'exit-error',
    'already-killed',
    'output-exists',
  ] as const)(
    'cleans up a failed process without returning sensitive stderr: %s',
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), 'pg-dump-failure-'));
      const output = join(directory, 'dump.sql.gz');
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        killed: boolean;
        kill: jest.Mock;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = mode === 'already-killed';
      child.kill = jest.fn(() => {
        child.killed = true;
        child.stdout.destroy();
        child.stderr.destroy();
        return true;
      });
      const spawnProcess = jest.fn(() => {
        setImmediate(() => {
          child.stderr.end('sensitive fixture connection detail');
          if (mode === 'spawn-error')
            child.emit('error', new Error('sensitive start detail'));
          else if (mode !== 'output-exists') child.emit('close', 2);
          else {
            child.stdout.end('CREATE TABLE fixture ();');
            child.emit('close', 0);
          }
          if (mode !== 'output-exists') child.stdout.end();
        });
        return child;
      });
      try {
        if (mode === 'output-exists')
          await writeFile(output, 'existing artifact');
        const runner = new PgDumpRunner(
          spawnProcess as unknown as typeof spawn,
        );
        await expect(
          runner.dump(
            'postgresql://fixture:secret@db.invalid/database',
            output,
            directory,
          ),
        ).rejects.toThrow('PostgreSQL backup failed');
        expect(spawnProcess).toHaveBeenCalledWith(
          'pg_dump',
          ['--no-owner', '--no-privileges', '--no-password'],
          expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
        );
        expect(child.kill).toHaveBeenCalledTimes(
          mode === 'already-killed' ? 0 : 1,
        );
        if (mode === 'output-exists')
          expect(readFileSync(output, 'utf8')).toBe('existing artifact');
      } finally {
        child.stdout.destroy();
        child.stderr.destroy();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('does not start a process when its private password file cannot be written', async () => {
    const spawnProcess = jest.fn();
    const directory = await mkdtemp(
      join(tmpdir(), 'pg-dump-password-failure-'),
    );
    try {
      const runner = new PgDumpRunner(spawnProcess as unknown as typeof spawn);
      await expect(
        runner.dump(
          'postgresql://fixture:secret@db.invalid/database',
          join(directory, 'dump.sql.gz'),
          join(directory, 'missing-directory'),
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(spawnProcess).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
