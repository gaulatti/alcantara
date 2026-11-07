'use strict';

const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const { buildSourceCoverage } = require('./build-source-coverage.cjs');
const cwd = resolve(__dirname, '..');

function run(args, spawn = spawnSync, build = buildSourceCoverage) {
  const compiled = spawn('pnpm', ['run', 'build'], { cwd, stdio: 'inherit' });
  if (compiled.error) throw compiled.error;
  if (compiled.status !== 0) return compiled.status ?? 1;
  build(cwd);
  const result = spawn(
    'pnpm',
    [
      'exec',
      'jest',
      '--config',
      './test/jest-coverage.config.cjs',
      '--coverage',
      ...args,
    ],
    {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, ALCANTARA_NATIVE_COVERAGE: '1' },
    },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

module.exports = { run };

if (require.main === module) process.exitCode = run(process.argv.slice(2));
