import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createAlanaRecordingFixture } from './fixtures/alana-recording-server.mjs';

const token =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

async function json(response) {
  return { status: response.status, body: await response.json() };
}

function controlledScheduler() {
  const callbacks = [];
  const waiters = [];
  return {
    schedule(callback) {
      callbacks.push(callback);
      waiters.shift()?.();
    },
    async runNext() {
      if (callbacks.length === 0) {
        await new Promise((resolve) => waiters.push(resolve));
      }
      assert.equal(callbacks.length, 1);
      callbacks.shift()();
    },
  };
}

test('fake Alana deterministically covers start, status, stop, finalize, and errors', async (t) => {
  const scheduler = controlledScheduler();
  const server = createAlanaRecordingFixture({
    token,
    schedule: scheduler.schedule,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const path = '/v1/programs/modoitaliano/recording';
  const headers = { Authorization: `Bearer ${token}` };

  const initial = await json(await fetch(`${origin}${path}`, { headers }));
  assert.deepEqual(
    { status: initial.status, state: initial.body.state },
    { status: 200, state: 'idle' },
  );
  assert.equal(initial.body.updatedAt, '2026-09-07T00:00:00.000Z');

  const notActive = await json(
    await fetch(`${origin}${path}/stop`, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'stop-idle' },
    }),
  );
  assert.deepEqual(
    {
      status: notActive.status,
      result: notActive.body.commandResult.result,
    },
    { status: 409, result: 'not-active' },
  );

  const started = await json(
    await fetch(`${origin}${path}/start`, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'start-1' },
    }),
  );
  assert.deepEqual(
    { status: started.status, state: started.body.state },
    { status: 202, state: 'requested' },
  );
  await scheduler.runNext();

  const active = await json(await fetch(`${origin}${path}`, { headers }));
  assert.deepEqual(
    { status: active.status, state: active.body.state },
    { status: 200, state: 'active' },
  );
  assert.equal(active.body.startedAt, '2026-09-07T00:00:03.000Z');

  const alreadyActive = await json(
    await fetch(`${origin}${path}/start`, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'start-2' },
    }),
  );
  assert.deepEqual(
    {
      status: alreadyActive.status,
      result: alreadyActive.body.commandResult.result,
    },
    { status: 409, result: 'already-active' },
  );

  const stopping = fetch(`${origin}${path}/stop`, {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': 'stop-1' },
  });
  await scheduler.runNext();
  const complete = await json(await stopping);
  assert.deepEqual(
    {
      status: complete.status,
      state: complete.body.state,
      finalizationState: complete.body.finalizationState,
    },
    { status: 200, state: 'complete', finalizationState: 'verified' },
  );
  assert.equal(complete.body.finalizedAt, '2026-09-07T00:00:07.000Z');

  const duplicate = await json(
    await fetch(`${origin}${path}/stop`, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'stop-1' },
    }),
  );
  assert.deepEqual(
    {
      status: duplicate.status,
      duplicate: duplicate.body.commandResult.duplicate,
    },
    { status: 200, duplicate: true },
  );

  const conflictingKey = await json(
    await fetch(`${origin}${path}/start`, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'stop-1' },
    }),
  );
  assert.deepEqual(
    {
      status: conflictingKey.status,
      result: conflictingKey.body.commandResult.result,
      duplicate: conflictingKey.body.commandResult.duplicate,
    },
    { status: 409, result: 'failed', duplicate: true },
  );

  const unauthorized = await json(await fetch(`${origin}${path}`));
  assert.deepEqual(unauthorized, {
    status: 401,
    body: { error: 'unauthorized' },
  });
  assert.doesNotMatch(JSON.stringify(unauthorized), new RegExp(token));
});
