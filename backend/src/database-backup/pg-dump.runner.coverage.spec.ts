import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { PgDumpRunner, libpqConnectionFromDatabaseUrl } from './pg-dump.runner';

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill: jest.Mock;
};

const malformed = 'Database backup configuration is malformed';

function fakeChild(script: (child: FakeChild) => void, killed = false) {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = killed;
  child.kill = jest.fn(() => {
    child.killed = true;
  });
  process.nextTick(() => script(child));
  return child;
}

describe('libpqConnectionFromDatabaseUrl', () => {
  it('defaults the port, omits absent ssl settings and decodes components', () => {
    const connection = libpqConnectionFromDatabaseUrl(
      'postgres://us%40er:pa%20ss@host.example/my%20db',
    );
    expect(connection.environment).toEqual({
      PGHOST: 'host.example',
      PGPORT: '5432',
      PGUSER: 'us@er',
      PGDATABASE: 'my db',
    });
    expect(connection.passwordFileContents).toBe(
      'host.example:5432:my db:us@er:pa ss',
    );
  });

  it('allows an empty password', () => {
    expect(
      libpqConnectionFromDatabaseUrl('postgresql://u@h/db')
        .passwordFileContents,
    ).toBe('h:5432:db:u:');
  });

  it('passes through only sslmode or only sslrootcert when present', () => {
    expect(
      libpqConnectionFromDatabaseUrl('postgresql://u:p@h/db?sslmode=require')
        .environment,
    ).toEqual({
      PGHOST: 'h',
      PGPORT: '5432',
      PGUSER: 'u',
      PGDATABASE: 'db',
      PGSSLMODE: 'require',
    });
    expect(
      libpqConnectionFromDatabaseUrl(
        'postgresql://u:p@h/db?sslrootcert=%2Fca.pem',
      ).environment,
    ).toEqual({
      PGHOST: 'h',
      PGPORT: '5432',
      PGUSER: 'u',
      PGDATABASE: 'db',
      PGSSLROOTCERT: '/ca.pem',
    });
  });

  it.each([
    ['unparseable', 'not a url'],
    ['wrong protocol', 'mysql://u:p@h/db'],
    ['missing host', 'postgresql:///db'],
    ['missing user', 'postgresql://h/db'],
    ['missing database', 'postgresql://u:p@h/'],
    ['bad percent-encoding in user', 'postgresql://u%E0%A4%A:p@h/db'],
    ['bad percent-encoding in password', 'postgresql://u:p%E0%A4%A@h/db'],
    ['newline in password', 'postgresql://u:p%0Aq@h/db'],
    ['carriage return in user', 'postgresql://u%0Dx:p@h/db'],
  ])('rejects %s without echoing the input', (_name, input) => {
    expect(() => libpqConnectionFromDatabaseUrl(input)).toThrow(malformed);
    try {
      libpqConnectionFromDatabaseUrl(input);
    } catch (error) {
      expect((error as Error).message).not.toContain(input);
    }
  });
});

describe('PgDumpRunner failure handling', () => {
  let directory: string;
  let output: string;
  const url = 'postgresql://u:p@db.internal/alcantara';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pg-dump-cov-'));
    output = join(directory, 'backup.sql.gz');
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('writes the passfile owner-only and spawns with a clean environment', async () => {
    const spawn = jest.fn(() =>
      fakeChild((c) => {
        c.stdout.end('data');
        c.stderr.end();
        c.emit('close', 0);
      }),
    );
    await new PgDumpRunner(spawn as never).dump(url, output, directory);
    const passfile = join(directory, '.pgpass');
    expect(readFileSync(passfile, 'utf8')).toBe(
      'db.internal:5432:alcantara:u:p\n',
    );
    expect(statSync(passfile).mode & 0o777).toBe(0o600);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    const [, , options] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; stdio: string[] },
    ];
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(options.env.PGPASSFILE).toBe(passfile);
    expect(gunzipSync(readFileSync(output)).toString()).toBe('data');
  });

  it('fails when the process cannot start, and kills a still-running child', async () => {
    let child: FakeChild | undefined;
    const spawn = () => {
      child = fakeChild((c) => {
        c.emit('error', new Error('ENOENT pg_dump'));
        c.stdout.end();
      });
      return child;
    };
    await expect(
      new PgDumpRunner(spawn as never).dump(url, output, directory),
    ).rejects.toThrow('PostgreSQL backup failed');
    expect(child?.kill).toHaveBeenCalledTimes(1);
  });

  it('fails on a non-zero exit code without leaking stderr', async () => {
    let child: FakeChild | undefined;
    const spawn = () => {
      child = fakeChild((c) => {
        c.stderr.write('FATAL: password authentication failed for user "u"');
        c.stdout.end();
        c.emit('close', 1);
      });
      return child;
    };
    const failure = new PgDumpRunner(spawn as never).dump(
      url,
      output,
      directory,
    );
    await expect(failure).rejects.toThrow(/^PostgreSQL backup failed$/);
    expect(child?.kill).toHaveBeenCalledTimes(1);
  });

  it('does not kill a child that is already marked killed', async () => {
    let child: FakeChild | undefined;
    const spawn = () => {
      child = fakeChild((c) => {
        c.stdout.end();
        c.emit('close', 2);
      }, true);
      return child;
    };
    await expect(
      new PgDumpRunner(spawn as never).dump(url, output, directory),
    ).rejects.toThrow('PostgreSQL backup failed');
    expect(child?.kill).not.toHaveBeenCalled();
  });

  it('refuses to overwrite an existing output file', async () => {
    writeFileSync(output, 'existing');
    const spawn = () =>
      fakeChild((c) => {
        c.stdout.end('data');
        c.emit('close', 0);
      });
    await expect(
      new PgDumpRunner(spawn as never).dump(url, output, directory),
    ).rejects.toThrow('PostgreSQL backup failed');
    expect(readFileSync(output, 'utf8')).toBe('existing');
  });

  it('rejects a malformed database URL before writing a passfile or spawning', async () => {
    const spawn = jest.fn();
    await expect(
      new PgDumpRunner(spawn as never).dump('nope', output, directory),
    ).rejects.toThrow(malformed);
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(join(directory, '.pgpass'))).toBe(false);
  });
});
