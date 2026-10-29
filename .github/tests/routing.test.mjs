import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {parse} from 'yaml';
import {evaluate, allowed} from './workflow-expressions.mjs';

const workflow = parse(readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8'));
const sharedWorkflow = parse(readFileSync(new URL('../../.clouseau-ci/.github/workflows/ci.yml', import.meta.url), 'utf8'));
const config = JSON.parse(readFileSync(new URL('../clouseau.json', import.meta.url), 'utf8'));

function context(event, {draft = false, pullRequest = '', provider = false, author = false, fork = false, assessment = 'success', record = true, repair = false, gate = 'success'} = {}) {
  return {
    github: {event_name: event, repository: 'gaulatti/alcantara', event: {pull_request: {number: 14, draft, head: {repo: {full_name: fork ? 'external/contribution' : 'gaulatti/alcantara'}}}}, run_id: 1000},
    inputs: {pull_request: pullRequest, check_provider: provider, check_author: author},
    needs: {'assess-intent': {result: assessment, outputs: {assessment: JSON.stringify({record_digest: record ? 'a'.repeat(64) : '', repair_digest: repair ? 'b'.repeat(64) : ''})}}, 'approve-and-merge': {result: gate}},
    steps: {coverage: {outcome: 'success'}},
  };
}

const cases = [
  ['PR', context('pull_request'), true, false],
  ['draft PR', context('pull_request', {draft: true}), true, false],
  ['PR review', context('pull_request_target'), false, true],
  ['draft review', context('pull_request_target', {draft: true}), false, false],
  ['comment', context('issue_comment'), false, false],
  ['manual tests', context('workflow_dispatch'), true, false],
  ['manual reassessment', context('workflow_dispatch', {pullRequest: '14'}), false, false],
  ['provider diagnostic', context('workflow_dispatch', {provider: true}), false, false],
  ['author diagnostic', context('workflow_dispatch', {author: true}), false, false],
];

function assertRoute(w, label, c, verify, approve) {
  const v = w.jobs.verify;
  assert.ok(allowed(v.if, c), `${label}: verification label must be resolved`);
  assert.equal(evaluate(v.name, c).coerceString(), verify ? 'verify' : 'metadata-only', `${label}: verification context`);
  for (const step of v.steps) {
    assert.equal(allowed(step.if, c), verify, `${label}: verification step ${step.name || step.uses}`);
  }
  const a = w.jobs['approve-and-merge'];
  assert.ok(allowed(a.if, c), `${label}: approval label must be resolved`);
  assert.equal(evaluate(a.name, c).coerceString(), approve ? 'approve-and-merge' : 'metadata-only-approval', `${label}: approval context`);
  assert.equal(allowed(a.steps[0].if, c), false, `${label}: successful assessment`);
  for (const step of a.steps.slice(1)) {
    assert.equal(allowed(step.if, c), approve, `${label}: approval step ${step.name || step.uses}`);
  }
}

for (const [label, c, verify, approve] of cases) {
  test(`${label}: readable labels and no unintended code, or approval work`, () => {
    assertRoute(workflow, label, c, verify, approve);
  });
}

for (const assessment of ['failure', 'cancelled', 'skipped']) {
  test(`${assessment} assessment fails the real approval job before checkout or approval`, () => {
    const c = context('pull_request_target', {assessment});
    const job = workflow.jobs['approve-and-merge'];
    assert.ok(allowed(job.if, c, {success: false}));
    assert.equal(evaluate(job.name, c).coerceString(), 'approve-and-merge');
    assert.ok(allowed(job.steps[0].if, c));
    assert.equal(job.steps[0].run.trim(), 'exit 1');
    for (const step of job.steps.slice(1)) assert.equal(allowed(step.if, c, {success: false}), false);
  });
}

test('failed verification cannot proceed to downstream build or coverage evidence', () => {
  const c = context('pull_request');
  c.steps.coverage.outcome = 'failure';
  for (const step of workflow.jobs.verify.steps) assert.equal(allowed(step.if, c, {success: false}), false);
});

test('trusted checkout, provider separation, and required evidence steps are preserved', () => {
  assert.deepEqual(workflow.jobs.verify.permissions, {contents: 'read'});
  assert.ok(!JSON.stringify(workflow.jobs.verify).includes('secrets.'));
  const approval = workflow.jobs['approve-and-merge'];
  const checkout = approval.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, 'main');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.ok(!JSON.stringify(approval).includes('provider-key'));
  assert.ok(config.verification.steps.includes('Test workflow routing'));
  for (const name of config.verification.steps) {
    assert.ok(workflow.jobs.verify.steps.some(step => step.name === name), `required step ${name}`);
  }
});

test('approval downloads only a complete record from its own run and attempt', () => {
  const assess = workflow.jobs['assess-intent'];
  const upload = assess.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  const download = workflow.jobs['approve-and-merge'].steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(assess.permissions.contents, 'read');
  assert.equal(assess.permissions['pull-requests'], 'read');
  assert.equal(assess.permissions.issues, 'read');
  assert.equal(upload.with.name, 'clouseau-acceptance-${{ github.run_id }}-${{ github.run_attempt }}');
  assert.equal(download.with.name, upload.with.name);
  assert.equal(download.with.path, 'work');
  assert.ok(allowed(download.if, context('pull_request_target')));
  assert.equal(allowed(download.if, context('pull_request_target', {record: false})), false);
  assert.equal(allowed(download.if, context('pull_request_target', {assessment: 'failure'})), false);
  assert.equal(allowed(download.if, context('pull_request')), false);
});

test('bounded repair runs only after a failed gate with a concrete proposal on a ready PR', () => {
  const job = workflow.jobs['apply-repair'];
  const valid = context('pull_request_target', {repair: true, gate: 'failure'});
  assert.ok(allowed(job.if, valid, {success: false}));
  for (const c of [
    context('pull_request_target', {repair: false, gate: 'failure'}),
    context('pull_request_target', {repair: true, gate: 'success'}),
    context('pull_request_target', {repair: true, gate: 'failure', assessment: 'failure'}),
    context('pull_request_target', {repair: true, gate: 'failure', draft: true}),
    context('pull_request_target', {repair: true, gate: 'failure', fork: true}),
    context('pull_request', {repair: true, gate: 'failure'}),
    context('issue_comment', {repair: true, gate: 'failure'}),
    context('workflow_dispatch', {repair: true, gate: 'failure'}),
  ]) assert.equal(allowed(job.if, c, {success: false}), false);
  assert.equal(job.concurrency.group, workflow.jobs['approve-and-merge'].concurrency.group.replace(
    "github.event_name == 'pull_request_target' && github.event.pull_request.number || github.run_id", 'github.event.pull_request.number'));
  const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, 'main');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(job.permissions.contents, 'read');
  const writer = job.steps.find(step => step.with?.operation === 'repair');
  assert.equal(writer.with['repair-token'], '${{ secrets.DEPLOYMENT_TOKEN }}');
  for (const [name, other] of Object.entries(workflow.jobs)) {
    if (['apply-repair', 'check-author'].includes(name)) continue;
    assert.ok(!JSON.stringify(other).includes('secrets.DEPLOYMENT_TOKEN'), `${name}: no author token`);
  }
  assert.ok(!JSON.stringify(job).includes('provider-key'));
  assert.ok(!JSON.stringify(job).includes('secrets.DEEPSEEK_API_KEY'));
});

test('consumer and pinned shared workflows stop fork repair before the author credential is loaded', () => {
  for (const [name, w] of [['consumer', workflow], ['shared', sharedWorkflow]]) {
    const job = w.jobs['apply-repair'];
    const internal = context('pull_request_target', {repair: true, gate: 'failure'});
    const fork = context('pull_request_target', {repair: true, gate: 'failure', fork: true});
    assert.ok(allowed(job.if, internal, {success: false}), `${name}: internal repair remains eligible`);
    assert.equal(allowed(job.if, fork, {success: false}), false, `${name}: fork cannot load the author token`);
    const deleted = structuredClone(internal); deleted.github.event.pull_request.head.repo = null;
    assert.equal(allowed(job.if, deleted, {success: false}), false, `${name}: missing head identity`);
    const mutant = job.if.replace('github.event.pull_request.head.repo.full_name == github.repository &&', '');
    assert.equal(allowed(mutant, fork, {success: false}), true, `${name}: removing the guard is detected`);
  }
});

test('the routing checks reject missing guards and a skipped assessment-failure path', () => {
  for (const jobName of ['verify', 'approve-and-merge']) {
    const mutant = structuredClone(workflow);
    const checkout = mutant.jobs[jobName].steps.find(step => step.uses?.startsWith('actions/checkout@'));
    delete checkout.if;
    assert.throws(() => assertRoute(mutant, 'comment', context('issue_comment'), false, false), /comment: .*step actions\/checkout/);
  }
  const mutant = structuredClone(workflow);
  mutant.jobs['approve-and-merge'].steps[0].if = 'false';
  const c = context('pull_request_target', {assessment: 'failure'});
  assert.equal(allowed(mutant.jobs['approve-and-merge'].steps[0].if, c), false);
  assert.ok(allowed(workflow.jobs['approve-and-merge'].steps[0].if, c));
});
