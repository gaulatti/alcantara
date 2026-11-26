import assert from 'node:assert/strict';
import test from 'node:test';
import { onlyWorkerRpcTimeout, runWithRetry } from '../scripts/frontend-tests.mjs';

const TIMEOUT = 'Error: [vitest-worker]: Timeout calling "onTaskUpdate"';
const summary = ({ files = ' 281 passed (281)', tests = ' 2418 passed (2418)', errors = '1 error' } = {}) =>
  [` Test Files  ${files}`, `      Tests  ${tests}`, `     Errors  ${errors}`].join('\n');
const timeoutOnly = (errors) => `${summary({ errors })}\n${TIMEOUT}\n`;

test('retries when the only failure is one worker RPC timeout and every file passed', () => {
  assert.equal(onlyWorkerRpcTimeout(timeoutOnly()), true);
});

test('still matches with terminal colour codes around the summary', () => {
  const coloured = `\x1b[31mError\x1b[39m: [vitest-worker]: Timeout calling "onTaskUpdate"\n\x1b[1m Test Files \x1b[22m\x1b[32m281 passed\x1b[39m (281)\n Tests \x1b[32m2418 passed\x1b[39m (2418)\n Errors 1 error`;
  assert.equal(onlyWorkerRpcTimeout(coloured), true);
});

test('does not retry when a test file failed', () => {
  assert.equal(onlyWorkerRpcTimeout(timeoutOnly().replace(' 281 passed (281)', ' 1 failed | 280 passed (281)')), false);
});

test('does not retry when a test failed', () => {
  assert.equal(onlyWorkerRpcTimeout(timeoutOnly().replace(' 2418 passed (2418)', ' 1 failed | 2417 passed (2418)')), false);
});

test('does not retry when there is an error besides the timeout', () => {
  assert.equal(onlyWorkerRpcTimeout(timeoutOnly('2 errors')), false);
});

test('does not retry when a coverage threshold failed', () => {
  assert.equal(onlyWorkerRpcTimeout(`${timeoutOnly()}\nERROR: Coverage for lines (99.8%) does not meet global threshold (99.9%)`), false);
});

test('does not retry without a timeout line', () => {
  assert.equal(onlyWorkerRpcTimeout(summary()), false);
});

test('does not retry for a timeout on another method', () => {
  assert.equal(onlyWorkerRpcTimeout(summary() + '\nError: [vitest-worker]: Timeout calling "snapshotSaved"\n'), false);
});

test('a first attempt that passes is not re-run', async () => {
  let calls = 0;
  const code = await runWithRetry(async () => ({ code: ++calls === 1 ? 0 : 1, output: '' }));
  assert.equal(code, 0);
  assert.equal(calls, 1);
});

test('re-runs once after the timeout and reports the second attempt', async () => {
  const outputs = [{ code: 1, output: timeoutOnly() }, { code: 0, output: '' }];
  const logs = [];
  let calls = 0;
  const code = await runWithRetry(async () => outputs[calls++], (message) => logs.push(message));
  assert.equal(code, 0);
  assert.equal(calls, 2);
  assert.equal(logs.length, 1);
});

test('fails with the second attempt when the retry also times out', async () => {
  const outputs = [{ code: 1, output: timeoutOnly() }, { code: 3, output: timeoutOnly() }];
  let calls = 0;
  assert.equal(await runWithRetry(async () => outputs[calls++]), 3);
  assert.equal(calls, 2);
});

test('a real failure fails on the first attempt without a re-run', async () => {
  let calls = 0;
  const code = await runWithRetry(async () => ({ code: 1, output: summary({ files: ' 1 failed | 280 passed (281)' }) }));
  assert.equal(code, 1);
  assert.equal(++calls, 1);
});
