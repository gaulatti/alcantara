import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {parse} from 'yaml';

const workflow = parse(readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8'));
const checkout = workflow.jobs.verify.steps.find(step => step.with?.repository === 'gaulatti/clouseau');
const root = fileURLToPath(new URL('../../.clouseau-ci/', import.meta.url));
const {requestReview} = createRequire(import.meta.url)(`${root}/src/provider.cjs`);
const messages = [{role: 'system', content: 'Review the upload contract.'}, {role: 'user', content: 'A fictional upload bugfix.'}];
const reply = (finish, content) => ({ok: true, json: async () => ({choices: [{finish_reason: finish, message: {content}}]})});

test('consumer exercises the shared provider from its frozen run checkout', () => {
  const uses = Object.values(workflow.jobs).flatMap(job => job.steps ?? [])
    .filter(step => step.with?.operation).map(step => step.uses);
  assert.ok(uses.length > 0);
  assert.ok(uses.every(value => value === './.clouseau-ci'));
  assert.equal(checkout.with.ref, "${{ needs.resolve-clouseau.outputs.sha || '0000000000000000000000000000000000000000' }}");
  assert.equal(checkout.with.repository, 'gaulatti/clouseau');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), process.env.CLOUSEAU_ENGINE_SHA);
});

test('real pinned provider automatically recovers a truncated completion with identical evidence', async () => {
  const requests = [], delays = [], reports = [];
  const verdict = JSON.stringify({decision: 'auto_approve', test_integrity_supported: true});
  const result = await requestReview({messages, wait: async ms => delays.push(ms), report: line => reports.push(line),
    fetchImpl: async (_, options) => {
      requests.push(JSON.parse(options.body));
      return requests.length === 1 ? reply('length', 'incomplete output') : reply('stop', verdict);
    }});
  assert.deepEqual(result, {content: verdict});
  assert.deepEqual(requests.map(request => request.max_tokens), [4096, 8192]);
  assert.deepEqual(requests[0].messages, requests[1].messages);
  assert.deepEqual(delays, [1000]);
  assert.equal(reports.length, 2);
  assert.ok(reports.every(line => !line.includes('incomplete output')));
});

test('real pinned provider exhausts a fixed retry budget without returning partial approval', async () => {
  const requests = [], delays = [];
  const result = await requestReview({messages, wait: async ms => delays.push(ms),
    fetchImpl: async (_, options) => {
      requests.push(JSON.parse(options.body));
      return reply('length', '{"decision":"auto_approve"}');
    }});
  assert.deepEqual(requests.map(request => request.max_tokens), [4096, 8192, 16384]);
  assert.deepEqual(delays, [1000, 2000]);
  assert.match(result.failure, /incomplete after 3 attempt/);
  assert.equal(result.content, undefined);
});

test('real pinned provider never retries a complete negative or invalid review', async () => {
  for (const verdict of [
    JSON.stringify({decision: 'second_opinion', has_concerns: true}),
    JSON.stringify({test_integrity_supported: false}),
    'invalid JSON',
  ]) {
    let calls = 0;
    const result = await requestReview({messages,
      wait: async () => assert.fail('a complete verdict must not be retried'),
      fetchImpl: async () => {calls++; return reply('stop', verdict);}});
    assert.equal(calls, 1);
    assert.deepEqual(result, {content: verdict});
  }
});
