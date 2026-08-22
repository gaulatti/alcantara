import assert from 'node:assert/strict';
import test from 'node:test';

import { acceptStageSceneResponse } from './stageSceneResponse';

test('rejects an out-of-order stage response without exposing stale scene state', () => {
  const staleScene = { id: 12, name: 'Stale scene' };
  const accepted = acceptStageSceneResponse(
    { stagedSceneId: 12, stagedScene: staleScene, version: 4 },
    (payload, topic) => {
      assert.equal(topic, 'state');
      assert.equal((payload as { version: number }).version, 4);
      return false;
    },
  );

  assert.equal(accepted, null);
});

test('normalizes an accepted stage response for the control UI', () => {
  const scene = { id: 18, name: 'Accepted scene' };
  const accepted = acceptStageSceneResponse<typeof scene>(
    { stagedSceneId: 18, stagedScene: scene, version: 5 },
    () => true,
  );

  assert.deepEqual(accepted, { stagedSceneId: 18, stagedScene: scene });
  assert.deepEqual(
    acceptStageSceneResponse({ stagedSceneId: Number.NaN, stagedScene: null }, () => true),
    { stagedSceneId: null, stagedScene: null },
  );
});
