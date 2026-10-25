import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PrismaService } from '../src/prisma.service';

const { createCoverageMap } = require('istanbul-lib-coverage');

describe('native command entry points and real local migration transactions', () => {
  let directory: string;
  let prisma: PrismaService;
  const id = `native-cli-${randomUUID()}`;
  const subject = `fixture-subject-${id}`;
  const principalId = `fixture-principal-${id}`;
  const fixture = JSON.parse(
    readFileSync(
      join(__dirname, 'fixtures/production-runtime-secret.json'),
      'utf8',
    ),
  );

  beforeAll(async () => {
    const database = new URL(
      process.env.DATABASE_URL ?? 'postgresql://missing',
    );
    if (
      !['localhost', '127.0.0.1'].includes(database.hostname) ||
      database.pathname !== '/alcantara_ci'
    ) {
      throw new Error(
        'Native CLI tests require isolated local alcantara_ci PostgreSQL',
      );
    }
    directory = mkdtempSync(join(tmpdir(), 'alcantara-native-entrypoints-'));
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.sharedConsoleLayout.create({
      data: {
        id,
        ownerSubject: subject,
        name: id,
        scope: 'team',
        scopeId: id,
        sourceDeviceClass: 'desktop',
        profile: {},
      },
    });
  });

  afterAll(async () => {
    if (prisma) {
      try {
        await prisma.sharedConsoleLayout.deleteMany({ where: { id } });
      } finally {
        await prisma.$disconnect();
      }
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function command(
    entry: string,
    args: string[] = [],
    input?: string,
    environment: Record<string, string | undefined> = {},
  ) {
    const native = process.env.ALCANTARA_NATIVE_COVERAGE === '1';
    const coverageFile = join(
      __dirname,
      '../.coverage-dist',
      `${randomUUID()}.json`,
    );
    const nodeArgs = native
      ? ['--require', join(__dirname, '../scripts/capture-child-coverage.cjs')]
      : [];
    nodeArgs.push(
      join(__dirname, native ? '../.coverage-dist/src' : '../dist/src', entry),
      ...args,
    );
    const result = spawnSync(process.execPath, nodeArgs, {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
      input,
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        AWS_EC2_METADATA_DISABLED: 'true',
        ...environment,
        ...(native ? { ALCANTARA_CHILD_COVERAGE_FILE: coverageFile } : {}),
      },
    });
    if (result.error) throw result.error;
    if (native) {
      const instrumented = globalThis as typeof globalThis & {
        __coverage__?: Record<string, unknown>;
      };
      const coverage = createCoverageMap(instrumented.__coverage__ ?? {});
      coverage.merge(JSON.parse(readFileSync(coverageFile, 'utf8')));
      instrumented.__coverage__ = JSON.parse(JSON.stringify(coverage));
    }
    return result;
  }

  it('validates the fixture over real stdin without printing any configuration values', () => {
    const result = command(
      'config/runtime-secret-contract.js',
      [],
      JSON.stringify(fixture),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('Alcantara production secret contract passed\n');
    expect(result.stderr).toBe('');
    for (const value of Object.values(fixture) as string[])
      expect(result.stdout).not.toContain(value);
  });

  it.each(['{', 'null', '[]', '{}', ' '.repeat(65_537)])(
    'fails malformed, incomplete or oversized native stdin (%#)',
    (input) => {
      const result = command('config/runtime-secret-contract.js', [], input);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(
        /Alcantara production secret contract failed:/,
      );
    },
  );

  it.each([['unsupported'], ['export'], ['report'], ['apply']])(
    'returns usage status before database construction for %j',
    (...args: string[]) => {
      const result = command('identity/principals-cli.js', args);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/Usage:|path is required/);
      expect(result.stdout).toBe('');
    },
  );

  it('reports missing database bootstrap configuration before opening any migration client', () => {
    const result = command('identity/principals-cli.js', [
      'export',
      join(directory, 'must-not-exist.json'),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'ARAUCO_SECRET_ID or DATABASE_URL is required',
    );
    expect(result.stdout).toBe('');
  });

  it('exports real references privately and refuses to overwrite an existing export', () => {
    const output = join(directory, 'references.json');
    const environment = { DATABASE_URL: process.env.DATABASE_URL };
    const result = command(
      'identity/principals-cli.js',
      ['export', output],
      undefined,
      environment,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Wrote 1 Alcantara references for Pompeii.',
    );
    const original = readFileSync(output, 'utf8');
    expect(JSON.parse(original)).toEqual([
      {
        consumer: 'alcantara',
        reference: `SharedConsoleLayout:${id}`,
        subject,
      },
    ]);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    const repeated = command(
      'identity/principals-cli.js',
      ['export', output],
      undefined,
      environment,
    );
    expect(repeated.status).toBe(1);
    expect(repeated.stderr).toContain('EEXIST');
    expect(readFileSync(output, 'utf8')).toBe(original);
  });

  it('reports without mutation and applies the complete verified mapping once in real PostgreSQL', async () => {
    const report = join(directory, 'producer-report.json');
    writeFileSync(
      report,
      JSON.stringify({
        references: [
          {
            consumer: 'alcantara',
            reference: `SharedConsoleLayout:${id}`,
            subject,
            principal_id: principalId,
          },
        ],
        collisions: [],
        missing: [],
      }),
    );
    const environment = { DATABASE_URL: process.env.DATABASE_URL };
    const preview = command(
      'identity/principals-cli.js',
      ['report', report],
      undefined,
      environment,
    );
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain(
      'Pompeii blockers: 0 collision(s), 0 missing reference(s).',
    );
    expect(
      (await prisma.sharedConsoleLayout.findUniqueOrThrow({ where: { id } }))
        .ownerPrincipalId,
    ).toBeNull();
    const applied = command(
      'identity/principals-cli.js',
      ['apply', report],
      undefined,
      environment,
    );
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain(
      'Applied 1 canonical principal references.',
    );
    expect(
      await prisma.sharedConsoleLayout.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ ownerSubject: subject, ownerPrincipalId: principalId });
    const repeated = command(
      'identity/principals-cli.js',
      ['apply', report],
      undefined,
      environment,
    );
    expect(repeated.status).toBe(0);
    expect(repeated.stdout).toContain(
      'Applied 0 canonical principal references.',
    );
  });

  it('runs the real runtime preflight with valid local service configuration', () => {
    const environment = {
      PALAZZO_ALLOWED_URLS: fixture.palazzoAllowedUrls,
      ALANA_CONTROL_TOKEN: fixture.alanaControlToken,
      ALANA_CONTROL_URL: fixture.alanaControlUrl,
      EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION:
        fixture.externalSourceConfigCurrentVersion,
      EXTERNAL_SOURCE_CONFIG_KEYS: fixture.externalSourceConfigKeys,
    };
    const result = command(
      'config/runtime-preflight.js',
      [],
      undefined,
      environment,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('Alcantara runtime preflight passed\n');
    expect(result.stderr).toBe('');
  });

  it('fails the native preflight on missing configuration and production test-auth before any AWS call', () => {
    const missing = command('config/runtime-preflight.js');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(
      'PALAZZO_ALLOWED_URLS must contain an approved URL',
    );
    const unsafe = command('config/runtime-preflight.js', [], undefined, {
      NODE_ENV: 'production',
      AUTH_MODE: 'test',
    });
    expect(unsafe.status).toBe(1);
    expect(unsafe.stderr).toContain(
      'AUTH_MODE=test must never run with NODE_ENV=production',
    );
    expect(unsafe.stderr).not.toContain('ALCANTARA_CONFIG_SECRET_ID');
  });
});
