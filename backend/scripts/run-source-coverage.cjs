'use strict';

const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const { buildSourceCoverage } = require('./build-source-coverage.cjs');
const cwd = resolve(__dirname, '..');
const build = spawnSync('pnpm', ['run', 'build'], { cwd, stdio: 'inherit' });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
buildSourceCoverage(cwd);
const result = spawnSync(
  'pnpm',
  [
    'exec',
    'jest',
    '--config',
    './test/jest-coverage.config.cjs',
    '--coverage',
    ...process.argv.slice(2),
  ],
  {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ALCANTARA_NATIVE_COVERAGE: '1' },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
