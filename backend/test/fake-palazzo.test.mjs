import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { startFakePalazzo } from './fixtures/fake-palazzo-server.mjs';

// The fake Palazzo behind the opt-in `fake-palazzo` Compose profile (docs/fake-palazzo.md): it answers the radio
// recovery path the way the real engine's contract does, and nothing that ships enables it.

const SHA = 'a'.repeat(64);

// The fixture serves one in-memory station per process, so its checks share one running fake.
let origin;

async function call(origin, method, path, { body, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function preparesBindsAndClears() {
  const program = '/v1/programs/radio-demo';

  const health = await call(origin, 'GET', '/__fake/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  const state = await call(origin, 'GET', `${program}/playback/state`);
  assert.equal(state.status, 200);
  assert.equal(state.body.schemaVersion, 1);
  assert.equal(state.body.status, 'idle');

  // Preparation, as RadioService.prepareRecoveryPlaylist sends it through PalazzoMachineClient.prepareFiller.
  const prepared = await call(origin, 'PUT', `${program}/fillers/walk-1`, {
    headers: { 'Idempotency-Key': 'walk-1' },
    body: {
      commandId: 'walk-1',
      mode: 'ordered',
      assets: [
        { id: 'song-9101', sha256: SHA, downloadUrl: 'http://localstack:4566/a.mp3' },
        { id: 'song-9102', sha256: SHA, downloadUrl: 'http://localstack:4566/b.mp3' },
      ],
    },
  });
  assert.equal(prepared.status, 200);
  assert.deepEqual(
    { version: prepared.body.version, ready: prepared.body.ready, status: prepared.body.status },
    { version: 'walk-1', ready: true, status: 'ready' },
  );
  const readBack = await call(origin, 'GET', `${program}/fillers/walk-1`);
  assert.equal(readBack.body.ready, true);
  const unknown = await call(origin, 'GET', `${program}/fillers/never-prepared`);
  assert.deepEqual(
    { ready: unknown.body.ready, status: unknown.body.status },
    { ready: false, status: 'unprepared' },
  );

  // Start binds the prepared version; stop clears the binding.
  const started = await call(origin, 'POST', `${program}/automation/start`, {
    headers: {
      'Idempotency-Key': 'start-1',
      'X-Command-Sequence': '1',
      'X-Filler-Version': 'walk-1',
    },
  });
  assert.ok(started.status >= 200 && started.status < 300, `start answered ${started.status}`);
  const running = await call(origin, 'GET', `${program}/automation`);
  assert.equal(running.body.filler.ready, true);
  assert.equal(running.body.filler.activeVersion, 'walk-1');

  const stopped = await call(origin, 'POST', `${program}/automation/stop`, {
    headers: { 'Idempotency-Key': 'stop-1', 'X-Command-Sequence': '2' },
  });
  assert.ok(stopped.status >= 200 && stopped.status < 300, `stop answered ${stopped.status}`);
  const idle = await call(origin, 'GET', `${program}/automation`);
  assert.equal(idle.body.filler.ready, false);
}

async function refusesMalformedPreparation() {
  const refused = await call(
    origin,
    'PUT',
    '/v1/programs/radio-demo/fillers/bad-1',
    {
      headers: { 'Idempotency-Key': 'bad-1' },
      body: { commandId: 'bad-1', mode: 'ordered', assets: [{ id: 'x', sha256: 'not-hex', downloadUrl: 'x' }] },
    },
  );
  assert.equal(refused.status, 400);
}

/** Opens the program's event stream and collects the event types it delivers for `ms`. */
async function eventTypes(path, ms) {
  const controller = new AbortController();
  const response = await fetch(`${origin}${path}`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const types = [];
  let buffer = '';
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const match of buffer.matchAll(/^event: (.+)$/gm)) types.push(match[1]);
      buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
    }
  } catch {
    // The abort ends the read.
  } finally {
    clearTimeout(timer);
  }
  return types;
}

// gaulatti/alcantara#734: Palazzo with Liquidsoap down sends one telemetry.disconnected and then nothing on its event
// stream, while its HTTP API still answers. mute-events lets a walk reproduce that without pausing the container.
async function mutesEventsAsLiquidsoapDown() {
  const program = '/v1/programs/radio-mute';
  const events = `${program}/playback/events`;
  const live = await eventTypes(events, 2_500);
  assert.equal(live[0], 'snapshot');
  assert.ok(live.includes('playback.position'), `live stream: ${live.join(',')}`);

  const muted = await call(origin, 'POST', '/__fake/programs/radio-mute/mute-events', {
    body: { muted: true },
  });
  assert.deepEqual(muted.body, { ok: true, muted: true });
  const silent = await eventTypes(events, 2_500);
  // A reconnect still gets its snapshot at once, then nothing: no position, levels or heartbeat.
  assert.deepEqual(silent, ['snapshot']);

  const state = await call(origin, 'GET', `${program}/playback/state`);
  assert.equal(state.status, 200);
  assert.equal(state.body.liquidsoap.connected, false);
  assert.match(state.body.liquidsoap.staleSince, /^\d{4}-\d{2}-\d{2}T/);
  const control = await call(origin, 'GET', '/__fake/programs/radio-mute');
  assert.equal(control.body.eventsMuted, true);

  // Muting twice emits nothing more; unmuting is Liquidsoap coming back.
  await call(origin, 'POST', '/__fake/programs/radio-mute/mute-events', { body: { muted: true } });
  const unmuted = await call(origin, 'POST', '/__fake/programs/radio-mute/mute-events', {
    body: { muted: false },
  });
  assert.deepEqual(unmuted.body, { ok: true, muted: false });
  const back = await eventTypes(events, 2_500);
  assert.ok(back.includes('playback.position'), `after unmute: ${back.join(',')}`);
  const restored = await call(origin, 'GET', `${program}/playback/state`);
  assert.equal(restored.body.liquidsoap.connected, true);
  assert.equal(restored.body.liquidsoap.staleSince, null);

  const refused = await call(origin, 'POST', '/__fake/programs/radio-mute/mute-events', {
    body: { muted: 'yes' },
  });
  assert.equal(refused.status, 400);
}

test('the fake Palazzo answers the recovery path', async (t) => {
  const fake = await startFakePalazzo({ port: 0, host: '127.0.0.1' });
  origin = `http://127.0.0.1:${fake.port}`;
  try {
    await t.test(
      'prepares a recovery playlist, binds it on start and clears it on stop',
      preparesBindsAndClears,
    );
    await t.test('refuses a malformed preparation', refusesMalformedPreparation);
    await t.test(
      'mutes the event stream as Palazzo does with Liquidsoap down',
      mutesEventsAsLiquidsoapDown,
    );
  } finally {
    await fake.close();
  }
});

// Everything that ships: the deploy scripts, the workflows, the infrastructure and the production Dockerfile.
function filesUnder(path) {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path).flatMap((entry) =>
    entry === 'node_modules' ? [] : filesUnder(join(path, entry)),
  );
}

test('nothing that ships runs or enables the fake Palazzo', () => {
  const shipped = [
    ...filesUnder('../deploy'),
    ...filesUnder('../.github/workflows'),
    ...filesUnder('../infra'),
    './Dockerfile',
  ];
  for (const file of shipped) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /fake-palazzo/, `${file} names the fake Palazzo`);
    // Its control routes, mute-events (#734) among them, are local-walk tools only.
    assert.doesNotMatch(text, /__fake\/|mute-events/, `${file} names a fake Palazzo control`);
  }
});

// The service blocks of compose.yml: each top-level service name with the lines indented under it.
function composeServices(compose) {
  const services = new Map();
  let inServices = false;
  let current = null;
  for (const line of compose.split('\n')) {
    if (/^\S/.test(line)) {
      inServices = line.startsWith('services:');
      current = null;
      continue;
    }
    if (!inServices) continue;
    const name = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (name) {
      current = name[1];
      services.set(current, []);
    } else if (current && (line.startsWith('    ') || line.trim() === '')) {
      services.get(current).push(line);
    }
  }
  return services;
}

test('Compose runs the fake Palazzo only under its opt-in profile', () => {
  const services = composeServices(readFileSync('../compose.yml', 'utf8'));
  const palazzo = services.get('palazzo');
  assert.ok(palazzo, 'compose.yml has a palazzo service');
  assert.ok(
    palazzo.includes('    profiles: ["fake-palazzo"]'),
    'the palazzo service runs only under the fake-palazzo profile',
  );
  assert.ok(palazzo.some((line) => line.includes('test/fixtures/fake-palazzo-server.mjs')));
  // No other service runs the fake or waits for it, so the default stack never starts it.
  for (const [name, lines] of services) {
    if (name === 'palazzo') continue;
    const block = lines.join('\n');
    assert.doesNotMatch(block, /fake-palazzo/, `${name} names the fake Palazzo`);
    assert.doesNotMatch(block, /^ {6}palazzo:/m, `${name} depends on palazzo`);
  }
});
