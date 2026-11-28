// The holders' renderer key lines from the runtime secret (gaulatti/alcantara#884). Fictional values, built here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { rendererEnvLines } from '../scripts/renderer-env.mjs';

const A = `alrk_${'a'.repeat(43)}`;
const B = `alrk_${'b'.repeat(43)}`;

test('gives the runner the shared key, the fleet key and every program key as one JSON line', () => {
  assert.deepEqual(
    rendererEnvLines({ webrtcRendererKey: 'shared', webrtcFleetKey: 'fleet', webrtcProgramKeys: { 'station-a': A, 'station-b': B } }),
    { lines: ['WEBRTC_RENDERER_KEY=shared', 'WEBRTC_FLEET_KEY=fleet', `WEBRTC_PROGRAM_KEYS={"station-a":"${A}","station-b":"${B}"}`] },
  );
});

test("gives a worker its own program's key only, and nothing for a program with none", () => {
  const secret = { webrtcRendererKey: 'shared', webrtcProgramKeys: { 'station-a': A, 'station-b': B } };
  assert.deepEqual(rendererEnvLines(secret, { program: 'station-a' }), { lines: ['WEBRTC_RENDERER_KEY=shared', `WEBRTC_PROGRAM_KEY=${A}`] });
  assert.deepEqual(rendererEnvLines(secret, { program: 'station-c' }), { lines: ['WEBRTC_RENDERER_KEY=shared'] });
});

test('says when the secret holds no key, and refuses a value an env file cannot hold, naming the field only', () => {
  assert.deepEqual(rendererEnvLines({}), { lines: [] });
  assert.deepEqual(rendererEnvLines({ webrtcProgramKeys: {} }), { lines: [] });
  assert.deepEqual(rendererEnvLines({ webrtcFleetKey: 'a\nb' }), { problem: 'WEBRTC_FLEET_KEY cannot be written to an env file' });
  assert.deepEqual(rendererEnvLines({ webrtcRendererKey: "it's" }), { problem: 'WEBRTC_RENDERER_KEY cannot be written to an env file' });
});
