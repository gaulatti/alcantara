import assert from 'node:assert/strict';
import test from 'node:test';

import { createExpiringSessionCache } from './expiring-session-cache';

test('coalesces concurrent loads and reuses an unexpired session', async () => {
  let loads = 0;
  const cache = createExpiringSessionCache(() => 1_000, 100);
  const load = async () => {
    loads += 1;
    return { value: `session-${loads}`, expiresAt: new Date(2_000).toISOString() };
  };

  const [first, second] = await Promise.all([cache.get(load), cache.get(load)]);
  assert.equal(first, 'session-1');
  assert.equal(second, 'session-1');
  assert.equal(await cache.get(load), 'session-1');
  assert.equal(loads, 1);
});

test('refreshes before expiry and clears a rejected load for retry', async () => {
  let now = 1_000;
  let loads = 0;
  const cache = createExpiringSessionCache(() => now, 100);
  const load = async () => {
    loads += 1;
    if (loads === 1) throw new Error('temporary failure');
    return { value: `session-${loads}`, expiresAt: new Date(2_000).toISOString() };
  };

  await assert.rejects(cache.get(load), /temporary failure/);
  assert.equal(await cache.get(load), 'session-2');

  now = 1_901;
  assert.equal(await cache.get(load), 'session-3');
  assert.equal(loads, 3);
});

test('rejects malformed expiry data and permits a later recovery', async () => {
  const cache = createExpiringSessionCache<string>();
  await assert.rejects(
    cache.get(async () => ({ value: 'bad', expiresAt: 'not-a-date' })),
    /invalid expiry/,
  );
  assert.equal(
    await cache.get(async () => ({ value: 'good', expiresAt: '2099-01-01T00:00:00.000Z' })),
    'good',
  );
});
