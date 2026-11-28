// #888 slice 2: the backend's ESLint error debt, as a checked-in shrink-only baseline. test/lint-debt.json maps each
// file under src/, apps/, libs/ and test/ to its ESLint error counts per rule. The test fails when any file gains an error
// (new debt), when any count exceeds its baseline, and when a baseline count is higher than the tree now produces, so the
// baseline can only shrink. Shrinking it means lowering the count in the same change. Warnings are not debt; they do not fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = join(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = JSON.parse(readFileSync(join(backend, 'test/lint-debt.json'), 'utf8'));
const eslint = join(backend, 'node_modules/.bin/eslint');

test('the ESLint error debt is exact: no new errors, no count above its baseline, and the baseline only shrinks', () => {
  const run = spawnSync(eslint, ['-f', 'json', '{src,apps,libs,test}/**/*.ts'], {
    cwd: backend,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  // ESLint exits 1 when it reports errors and 2 on a crash; a crash must fail, not pass as an empty report.
  assert.ok(run.status === 0 || run.status === 1, `eslint crashed: ${run.stderr}`);
  const report = JSON.parse(run.stdout);
  const actual = {};
  for (const file of report) {
    const rel = file.filePath.slice(backend.length + 1);
    const counts = {};
    for (const message of file.messages) {
      if (message.severity !== 2) continue;
      const rule = message.ruleId ?? '(parse)';
      counts[rule] = (counts[rule] ?? 0) + 1;
    }
    if (Object.keys(counts).length > 0) actual[rel] = counts;
  }

  const grown = [];
  for (const [file, rules] of Object.entries(actual)) {
    for (const [rule, count] of Object.entries(rules)) {
      const allowed = baseline[file]?.[rule] ?? 0;
      if (count > allowed) grown.push(`${file} ${rule}: ${count} > baseline ${allowed}`);
    }
  }
  assert.deepEqual(grown, [], 'new ESLint errors: fix them, do not raise test/lint-debt.json');

  const stale = [];
  for (const [file, rules] of Object.entries(baseline)) {
    assert.ok(existsSync(join(backend, file)), `baseline file does not exist: ${file}`);
    for (const [rule, allowed] of Object.entries(rules)) {
      const count = actual[file]?.[rule] ?? 0;
      if (count < allowed) stale.push(`${file} ${rule}: ${count} < baseline ${allowed}`);
    }
  }
  assert.deepEqual(stale, [], 'baseline counts above the tree: lower test/lint-debt.json in this change');
});
