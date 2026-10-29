import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const { createCoverageMap } = require('istanbul-lib-coverage');

describe('native command entry points report non-Error failures without leaking detail', () => {
  let directory: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'alcantara-native-failures-'));
  });
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function run(entry: string, preload: string, input?: string) {
    const native = process.env.ALCANTARA_NATIVE_COVERAGE === '1';
    const coverageFile = join(directory, `${randomUUID()}.json`);
    const preloadFile = join(directory, `${randomUUID()}.cjs`);
    writeFileSync(preloadFile, preload);
    const nodeArgs = native
      ? ['--require', join(__dirname, '../scripts/capture-child-coverage.cjs')]
      : [];
    nodeArgs.push(
      '--require',
      preloadFile,
      join(__dirname, native ? '../.coverage-dist/src' : '../dist/src', entry),
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

  it('fails the secret contract with an unknown-failure message when stdin rejects with a non-Error', () => {
    const result = run(
      'config/runtime-secret-contract.js',
      `Object.defineProperty(process, 'stdin', {
        value: { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject('stdin detail') }) },
      });`,
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'Alcantara production secret contract failed: unknown failure\n',
    );
  });

  it('fails the runtime preflight with an unknown-failure message when secret loading rejects with a non-Error', () => {
    const result = run(
      'config/runtime-preflight.js',
      `const Module = require('node:module');
      const load = Module._load;
      Module._load = function (request, ...rest) {
        if (request === './runtime-secrets') {
          return {
            loadRuntimeSecrets: () => Promise.reject('secret detail'),
            validateRuntimeConfiguration: () => undefined,
          };
        }
        return load.call(this, request, ...rest);
      };`,
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'Alcantara runtime preflight failed: unknown failure\n',
    );
  });
});
