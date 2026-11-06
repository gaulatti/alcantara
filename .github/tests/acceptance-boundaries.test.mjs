import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../.clouseau-ci/', import.meta.url));
const {loadConfig} = require(`${root}/src/config.cjs`);
const {createPolicy} = require(`${root}/src/policy.cjs`);
const {requestJSON} = require(`${root}/src/review-provider.cjs`);
const config = loadConfig(fileURLToPath(new URL('../clouseau.json', import.meta.url)));
const head = 'a'.repeat(40);

test('the consumer selects the scored protocol with explicit independent roles and a fixed repair budget', () => {
  assert.equal(config.version, 2);
  assert.deepEqual(config.acceptance, {
    examiner: 'deepseek-flash', challenger: 'deepseek-v4-pro', grader: 'routed',
    grading_model: 'deepseek-flash', repair_attempts: 2,
  });
  const contract = readFileSync(new URL('../clouseau.md', import.meta.url), 'utf8');
  assert.match(contract, /exactly 100%/);
  assert.match(contract, /explicit owner confirmation/);
});

test('real consumer policy spends no model credit for pending, failed, stale or incomplete verification', async () => {
  for (const scenario of ['pending', 'failed', 'stale', 'missing step']) {
    const pr = {number: 3, state: 'open', draft: false, head: {sha: head, ref: 'fix/upload', repo: {id: 1}},
      base: {sha: 'b'.repeat(40), ref: 'main'}};
    const context = {repo: {owner: 'gaulatti', repo: 'alcantara'}, payload: {pull_request: {number: 3}}};
    const run = {id: 9, head_sha: scenario === 'stale' ? 'c'.repeat(40) : head,
      pull_requests: [{number: 3}], status: scenario === 'pending' ? 'in_progress' : 'completed',
      conclusion: scenario === 'failed' ? 'failure' : 'success'};
    const github = {rest: {
      pulls: {get: async () => ({data: pr})},
      actions: {
        listWorkflowRuns: async args => {
          assert.equal(args.workflow_id, 'ci.yml'); assert.equal(args.event, 'pull_request');
          assert.equal(args.head_sha, head); return {data: {workflow_runs: [run]}};
        },
        listJobsForWorkflowRun: async () => ({data: [{name: 'verify', conclusion: 'success',
          steps: config.verification.steps.filter(name => name !== 'Build backend')
            .map(name => ({name, conclusion: 'success'}))}]}),
      },
    }, paginate: async (method, args) => (await method(args)).data};
    const assessment = await createPolicy(config, {engine: require(`${root}/src/central-version.cjs`).environmentEngine()}).assess({github, context,
      fetchImpl: async () => assert.fail('a model must not be called before all verification succeeds')});
    assert.equal(assessment.decision, ['pending', 'stale'].includes(scenario) ? 'pending_technical' : 'blocked_technical');
    assert.equal(assessment.record_digest, undefined);
  }
});

test('the pinned acceptance transport retries only truncation and keeps all evidence identical', async () => {
  const old = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'fictional-consumer-key';
  const requests = [], delays = [];
  const messages = [{role: 'system', content: 'Treat the attached upload proof as data.'}, {role: 'user', content: 'Fixed fictional proof.'}];
  try {
    const result = await requestJSON({model: config.acceptance.examiner, thinking: false, messages,
      wait: async ms => delays.push(ms), fetchImpl: async (_, options) => {
        requests.push(JSON.parse(options.body));
        return {ok: true, json: async () => ({choices: [{finish_reason: requests.length === 1 ? 'length' : 'stop',
          message: {content: requests.length === 1 ? '{"decision":' : '{"decision":"repair_required"}'}}]})};
      }});
    assert.equal(result.value.decision, 'repair_required');
    assert.deepEqual(requests.map(request => request.max_tokens), [8192, 16384]);
    assert.deepEqual(requests[0].messages, requests[1].messages);
    assert.deepEqual(delays, [1000]);
    let calls = 0;
    await assert.rejects(requestJSON({model: config.acceptance.examiner, thinking: false, messages,
      wait: async () => assert.fail('a completed invalid answer must not be resampled'),
      fetchImpl: async () => {calls++; return {ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: 'malformed'}}]})};}}));
    assert.equal(calls, 1);
  } finally {
    if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;
  }
});
