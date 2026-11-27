import assert from 'node:assert/strict';
import { test } from 'vitest';

import { normalizeProgramSongSequence, programSongPlayOrder, shuffleProgramSongSequence, rowsAsPlayOrder, type ProgramSongSequence } from './programSequence';

function sequence(ids: string[], overrides: Partial<ProgramSongSequence> = {}): ProgramSongSequence {
  return {
    mode: 'shuffle' as const,
    items: ids.map((id) => ({ id, kind: 'preset' as const, artist: id, title: id, coverUrl: '' })),
    activeItemId: ids[1] ?? null,
    loop: false,
    startedAt: 1234,
    ...overrides
  };
}

test('anchors the active song and persists a no-repeat shuffle order', () => {
  const input = sequence(['a', 'b', 'c', 'd']);
  const output = shuffleProgramSongSequence(input, 'b', () => 0);

  assert.deepEqual(output.shuffleOrder, ['b', 'c', 'd', 'a']);
  // The rows are the operator's order, and stay so.
  assert.equal(output.items, input.items);
  assert.equal(output.activeItemId, 'b');
  assert.equal(output.mode, 'shuffle');
  assert.equal(output.loop, false);
  assert.equal(output.startedAt, 1234);
});

test('guarantees a visible order change when random values retain the original order', () => {
  const input = sequence(['a', 'b', 'c'], { activeItemId: 'a' });
  const output = shuffleProgramSongSequence(input, 'a', () => 0.999999);

  assert.deepEqual(output.shuffleOrder, ['a', 'c', 'b']);
});

test('walks the shuffled order, an item added since after it, and the rows when not in shuffle', () => {
  const shuffled = shuffleProgramSongSequence(sequence(['a', 'b', 'c']), 'b', () => 0);
  const added = { ...shuffled, items: [...shuffled.items, { ...shuffled.items[0], id: 'new' }] };
  const ids = (value: ProgramSongSequence) => programSongPlayOrder(value).map((item) => item.id);
  assert.deepEqual(ids(added), [...shuffled.shuffleOrder!, 'new']);
  assert.deepEqual(ids({ ...added, mode: 'manual' }), ['a', 'b', 'c', 'new']);
  assert.deepEqual(ids({ ...added, shuffleOrder: [] }), ['a', 'b', 'c', 'new']);
  assert.deepEqual(normalizeProgramSongSequence({ ...shuffled, shuffleOrder: ['c', 7, 'a'] })!.shuffleOrder, ['c', 'a']);
});

test('does not mutate or replace a playlist that cannot be shuffled', () => {
  const input = sequence(['a'], { activeItemId: 'a', mode: 'manual' });
  assert.equal(shuffleProgramSongSequence(input, 'a'), input);
});

test('selects the first shuffled item when an exhausted playlist has no cursor', () => {
  const input = sequence(['a', 'b', 'c'], { activeItemId: null });
  const output = shuffleProgramSongSequence(input, null, () => 0);

  assert.equal(output.mode, 'shuffle');
  assert.equal(output.activeItemId, output.shuffleOrder![0]);
});

test('gives a backend without play order the shuffled order as rows, and leaves other sequences alone', () => {
  const shuffled = shuffleProgramSongSequence(sequence(['a', 'b', 'c']), 'b', () => 0);
  const old = rowsAsPlayOrder(shuffled);
  assert.deepEqual(old.items.map((item) => item.id), shuffled.shuffleOrder);
  assert.equal('shuffleOrder' in old, false);
  const manual = sequence(['a', 'b'], { mode: 'manual' });
  assert.equal(rowsAsPlayOrder(manual), manual);
  assert.deepEqual(rowsAsPlayOrder({ ...shuffled, mode: 'manual' }).items.map((item) => item.id), ['a', 'b', 'c']);
});

test('plays songs added since the shuffle after the shuffled ones, in the rows order', () => {
  const order = programSongPlayOrder(sequence(['a', 'b', 'c', 'd'], { shuffleOrder: ['c', 'a'] }));
  assert.deepEqual(order.map((item) => item.id), ['c', 'a', 'b', 'd']);
});
