// #888 slice 1: the backend's Prettier debt, as a checked-in list that may only shrink. Every file under src/ and test/
// must pass `prettier --check` unless it is on test/prettier-debt.txt; every listed file must still fail it and exist,
// so the list can only shrink. Formatting a listed file means removing it from the list in the same change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = join(dirname(fileURLToPath(import.meta.url)), '..');
const listed = readFileSync(join(backend, 'test/prettier-debt.txt'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .sort();
const prettier = join(backend, 'node_modules/.bin/prettier');

test('the Prettier debt list is exact: no other file fails, every listed file still fails and exists', () => {
  const run = spawnSync(prettier, ['--list-different', 'src/**/*.ts', 'test/**/*.ts'], {
    cwd: backend,
    encoding: 'utf8',
  });
  // Prettier exits 1 when files differ and 2 on an error; only the list is trusted, so an error is a failure.
  assert.ok(run.status === 0 || run.status === 1, `prettier failed: ${run.stderr}`);
  const failing = run.stdout.split('\n').map((line) => line.trim()).filter(Boolean).sort();
  const newlyFailing = failing.filter((file) => !listed.includes(file));
  const nowPassing = listed.filter((file) => !failing.includes(file));
  assert.deepEqual(newlyFailing, [], 'files that fail Prettier and are not on test/prettier-debt.txt: format them');
  assert.deepEqual(nowPassing, [], 'listed files that now pass Prettier: remove them from test/prettier-debt.txt');
  for (const file of listed) assert.ok(existsSync(join(backend, file)), `listed file does not exist: ${file}`);
});
