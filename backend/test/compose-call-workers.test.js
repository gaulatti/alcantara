// gaulatti/alcantara#51: a fresh clone's `docker compose up` runs both call workers against the local stack, so a
// guest reaches air and gets a return with no hand steps, and neither can reach anything outside the machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const compose = readFileSync(resolve(__dirname, '../..', 'compose.yml'), 'utf8');

/** One service's block: from its two-space name to the next line indented no deeper. */
const service = (name) => {
  const found = new RegExp(`\\n {2}${name}:\\n((?: {4}.*\\n|\\s*\\n)+)`).exec(compose);
  assert.ok(found, `compose.yml has a ${name} service`);
  return found[1];
};
const value = (block, key) => new RegExp(`\\n {6}${key}: (.+)\\n`).exec(block)?.[1];
const rendererKey = () => value(service('backend'), 'WEBRTC_RENDERER_KEY');

for (const [name, context] of [
  ['contribution', './infra/cumulus/contribution'],
  ['return-runner', './infra/helix/return-runner'],
]) {
  test(`Compose runs ${name} by default, from the image production builds, against the local backend`, () => {
    const block = service(name);
    assert.doesNotMatch(block, /profiles:/);
    assert.ok(block.includes(`      context: ${context}\n`));
    assert.equal(value(block, 'ALCANTARA_API_URL'), 'http://localhost:${BACKEND_PORT:-3000}');
    assert.equal(value(block, 'WEBRTC_RENDERER_KEY'), rendererKey());
    assert.doesNotMatch(block, /env_file:/);
  });
}

test('the contribution worker pushes only to the local sink, published on loopback', () => {
  assert.equal(
    value(service('contribution'), 'CONTRIBUTION_RTMP_URL'),
    'rtmp://localhost:${AIR_SINK_PORT:-1935}/live/contribution',
  );
  assert.ok(service('air-sink').includes('      - "127.0.0.1:${AIR_SINK_PORT:-1935}:1935"\n'));
});

test('the return runner opens the local console', () => {
  assert.equal(value(service('return-runner'), 'ALCANTARA_APP_URL'), 'http://localhost:${VITE_PORT:-5173}');
});
