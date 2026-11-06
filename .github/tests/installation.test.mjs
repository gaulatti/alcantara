import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {parse} from 'yaml';
import {allowed, evaluate} from './workflow-expressions.mjs';

const workflow = parse(readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8'));
const assess = workflow.jobs['assess-intent'];
const approval = workflow.jobs['approve-and-merge'];
const head = 'a'.repeat(40);

async function guard(mutate = () => {}) {
  const state = {context: {actor: 'gaulatti', repo: {owner: 'gaulatti', repo: 'alcantara'},
    ref: 'refs/heads/policy-install/pr-25', sha: head},
  pr: {state: 'open', draft: false, base: {ref: 'main'}, user: {login: 'gaulatti'},
    head: {sha: head, repo: {full_name: 'gaulatti/alcantara'}}},
  comments: [{user: {type: 'User', login: 'gaulatti'}, body: `/approve-intent ${head}`}], outputs: {}};
  mutate(state);
  const listComments = () => {};
  const github = {rest: {pulls: {get: async args => {
    assert.equal(args.pull_number, 25); return {data: state.pr};
  }}, issues: {listComments}}, paginate: async (method, args) => {
    assert.equal(method, listComments); assert.equal(args.issue_number, 25); return state.comments;
  }};
  const invoke = new (Object.getPrototypeOf(async function() {}).constructor)('context', 'github', 'core', assess.steps[0].with.script);
  await invoke(state.context, github, {setOutput: (key, value) => {state.outputs[key] = value;}});
  return state;
}

test('the real installation guard requires the owner, frozen ready internal PR and exact confirmation', async () => {
  assert.deepEqual((await guard()).outputs, {number: '25'});
  for (const mutate of [
    s => {s.context.actor = 'contributor';}, s => {s.context.ref = 'refs/heads/main';},
    s => {s.context.sha = 'invalid';}, s => {s.context.ref += '-other';},
    s => {s.context.ref = `refs/heads/policy-install/pr-${'9'.repeat(30)}`;},
    s => {s.pr.state = 'closed';}, s => {s.pr.draft = true;}, s => {s.pr.base.ref = 'other';},
    s => {s.pr.user.login = 'contributor';}, s => {s.pr.head.sha = 'b'.repeat(40);},
    s => {s.pr.head.repo = null;}, s => {s.pr.head.repo.full_name = 'external/fork';},
    s => {s.comments = [];}, s => {s.comments[0].user.type = 'Bot';},
    s => {s.comments[0].user.login = 'contributor';}, s => {s.comments[0].body = '/approve-intent stale';},
  ]) await assert.rejects(guard(mutate), /installation|Installation/);
});

test('installation is metadata-only and preserves read-only assessment, native failure and source verification', () => {
  const context = {github: {event_name: 'push', ref: 'refs/heads/policy-install/pr-25', event: {deleted: false}},
    inputs: {pull_request: '', check_provider: false, check_author: false}, steps: {},
    needs: {'assess-intent': {result: 'success', outputs: {number: '25', assessment: '{"record_digest":"proof"}'}}}};
  assert.equal(allowed(assess.if, context), true);
  assert.ok(Object.values(assess.permissions).every(value => value === 'read'));
  assert.equal(assess.steps[0].id, 'install');
  assert.equal(assess.steps.find(step => step.uses?.startsWith('actions/checkout@')).with.ref, 'main');
  assert.equal(evaluate(workflow.jobs.verify.name, context).coerceString(), 'metadata-only');
  for (const step of workflow.jobs.verify.steps) assert.equal(allowed(step.if, context), false);
  assert.equal(evaluate(approval.name, context).coerceString(), 'approve-and-merge');
  const review = assess.steps.find(step => step.with?.operation === 'assess');
  assert.equal(review.with['pull-request'], '${{ steps.install.outputs.number }}');
  assert.equal(review.with['wait-for-verification'], 'true');
  const gate = approval.steps.find(step => step.with?.operation === 'gate');
  assert.equal(gate.with['pull-request'], '${{ needs.assess-intent.outputs.number }}');
  assert.equal(gate.with['native-gate'], 'true');
  for (const result of ['failure', 'cancelled', 'skipped']) {
    const failed = structuredClone(context); failed.needs['assess-intent'].result = result;
    assert.equal(allowed(approval.steps[0].if, failed), true);
    assert.equal(approval.steps[0].run, 'exit 1');
    for (const step of approval.steps.slice(1)) assert.equal(allowed(step.if, failed, {success: false}), false);
  }
  for (const ref of ['refs/heads/main', 'refs/heads/feature/change']) {
    const unrelated = structuredClone(context); unrelated.github.ref = ref;
    assert.equal(allowed(assess.if, unrelated), false);
  }
  const deleted = structuredClone(context); deleted.github.event.deleted = true;
  assert.equal(allowed(assess.if, deleted), false);
  assert.equal(evaluate(approval.name, deleted).coerceString(), 'metadata-only-approval');
});
