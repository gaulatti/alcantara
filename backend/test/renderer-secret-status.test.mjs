// Which renderer keys the runtime secret holds, named and never valued (gaulatti/alcantara#884). Fictional values.
import assert from 'node:assert/strict';
import test from 'node:test';
import { rendererSecretStatus } from '../scripts/renderer-secret-status.mjs';

test('names the keys the secret holds, never a value', () => {
  const key = `alrk_${'a'.repeat(43)}`;
  const status = rendererSecretStatus({ webrtcFleetKey: 'fleet-fictional', webrtcRendererKey: 'shared-fictional', webrtcProgramKeys: { 'station-b': key, 'station-a': key } });
  assert.deepEqual(status, { fleetKey: true, sharedKey: true, programKeys: ['station-a', 'station-b'] });
  assert.doesNotMatch(JSON.stringify(status), /fictional|alrk_/);
  assert.deepEqual(rendererSecretStatus({}), { fleetKey: false, sharedKey: false, programKeys: [] });
  assert.deepEqual(rendererSecretStatus({ webrtcFleetKey: '' }), { fleetKey: false, sharedKey: false, programKeys: [] });
});
