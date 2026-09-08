import assert from 'node:assert/strict';
import test from 'node:test';

import { shuffleProgramSongSequence } from './programSequence.ts';

function sequence(ids, overrides = {}) {
  return {
    mode: 'shuffle',
    items: ids.map((id) => ({ id, kind: 'preset', artist: id, title: id, coverUrl: '' })),
    activeItemId: ids[1] ?? null,
    loop: false,
    startedAt: 1234,
    ...overrides
  };
}

test('anchors the active song and persists a no-repeat autoplay order', () => {
  const input = sequence(['a', 'b', 'c', 'd']);
  const output = shuffleProgramSongSequence(input, 'b', () => 0);

  assert.deepEqual(output.items.map((item) => item.id), ['b', 'c', 'd', 'a']);
  assert.equal(output.activeItemId, 'b');
  assert.equal(output.mode, 'autoplay');
  assert.equal(output.loop, false);
  assert.equal(output.startedAt, 1234);
  assert.deepEqual(new Set(output.items.map((item) => item.id)), new Set(['a', 'b', 'c', 'd']));
});

test('guarantees a visible order change when random values retain the original order', () => {
  const input = sequence(['a', 'b', 'c'], { activeItemId: 'a' });
  const output = shuffleProgramSongSequence(input, 'a', () => 0.999999);

  assert.deepEqual(output.items.map((item) => item.id), ['a', 'c', 'b']);
});

test('does not mutate or replace a playlist that cannot be shuffled', () => {
  const input = sequence(['a'], { activeItemId: 'a', mode: 'manual' });
  assert.equal(shuffleProgramSongSequence(input, 'a'), input);
});
