import { createServer } from 'node:http';
import { pathToFileURL, URL } from 'node:url';

const defaultStart = '2026-09-07T00:00:00.000Z';

export function createAlanaRecordingFixture({
  programId = 'modoitaliano',
  token,
  schedule = (callback) => setTimeout(callback, 250),
  startTimestamp = defaultStart,
} = {}) {
  if (!token) throw new Error('fixture token is required');
  const basePath = `/v1/programs/${encodeURIComponent(programId)}/recording`;
  const commands = new Map();
  const epoch = Date.parse(startTimestamp);
  if (!Number.isFinite(epoch)) throw new Error('fixture timestamp is invalid');
  let tick = 0;
  const timestamp = () => new Date(epoch + tick++ * 1_000).toISOString();
  const disk = {
    freeBytes: 8_000_000_000,
    usageBytes: 24_000_000,
    quotaBytes: 50_000_000_000,
    minimumFreeBytes: 1_000_000_000,
  };
  let state = {
    enabled: true,
    state: 'idle',
    requestedAt: null,
    startedAt: null,
    stoppedAt: null,
    finalizedAt: null,
    updatedAt: timestamp(),
    segmentCount: 0,
    bytes: 0,
    durationSeconds: 0,
    droppedFrames: 0,
    errors: 0,
    restarts: 0,
    finalizationState: 'not-requested',
    finalBytes: 0,
    error: null,
    disk,
  };

  function send(response, status, payload) {
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    response.end(`${JSON.stringify(payload)}\n`);
  }

  function command(response, action, key) {
    const prior = commands.get(key);
    if (prior) {
      if (prior.action !== action) {
        send(response, 409, {
          ...state,
          commandResult: {
            action,
            status: 409,
            result: 'failed',
            duplicate: true,
          },
        });
        return;
      }
      send(response, prior.status, {
        ...state,
        commandResult: { ...prior, duplicate: true },
      });
      return;
    }

    if (action === 'start') {
      if (['requested', 'active', 'finalizing'].includes(state.state)) {
        const result = { action, status: 409, result: 'already-active' };
        commands.set(key, result);
        send(response, 409, {
          ...state,
          commandResult: { ...result, duplicate: false },
        });
        return;
      }
      state = {
        ...state,
        state: 'requested',
        requestedAt: timestamp(),
        startedAt: null,
        stoppedAt: null,
        finalizedAt: null,
        updatedAt: timestamp(),
        segmentCount: 0,
        bytes: 0,
        durationSeconds: 0,
        finalizationState: 'not-requested',
        finalBytes: 0,
        error: null,
      };
      const result = { action, status: 202, result: 'accepted' };
      commands.set(key, result);
      send(response, 202, {
        ...state,
        commandResult: { ...result, duplicate: false },
      });
      schedule(() => {
        if (state.state !== 'requested') return;
        state = {
          ...state,
          state: 'active',
          startedAt: timestamp(),
          updatedAt: timestamp(),
          segmentCount: 1,
          bytes: 1_250_000,
          durationSeconds: 5,
        };
      });
      return;
    }

    if (!['requested', 'active'].includes(state.state)) {
      const result = { action, status: 409, result: 'not-active' };
      commands.set(key, result);
      send(response, 409, {
        ...state,
        commandResult: { ...result, duplicate: false },
      });
      return;
    }
    state = {
      ...state,
      state: 'finalizing',
      stoppedAt: timestamp(),
      updatedAt: timestamp(),
      finalizationState: 'pending',
    };
    const result = { action, status: 200, result: 'complete' };
    commands.set(key, result);
    schedule(() => {
      if (state.state !== 'finalizing') return;
      state = {
        ...state,
        state: 'complete',
        finalizedAt: timestamp(),
        updatedAt: timestamp(),
        finalizationState: 'verified',
        finalBytes: Math.max(state.bytes, 1_250_000),
      };
      send(response, 200, {
        ...state,
        commandResult: { ...result, duplicate: false },
      });
    });
  }

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture').pathname;
    if (request.method === 'GET' && path === '/health') {
      send(response, 200, { status: 'ok' });
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      send(response, 401, { error: 'unauthorized' });
      return;
    }
    if (request.method === 'GET' && path === basePath) {
      send(response, 200, state);
      return;
    }
    if (
      request.method === 'POST' &&
      (path === `${basePath}/start` || path === `${basePath}/stop`)
    ) {
      const key = String(request.headers['idempotency-key'] ?? '');
      if (!key || key.length > 200) {
        send(response, 400, { error: 'idempotency-key-required' });
        return;
      }
      command(response, path.endsWith('/start') ? 'start' : 'stop', key);
      return;
    }
    send(response, 404, { error: 'not-found' });
  });

  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(process.env.PORT ?? '8080');
  const server = createAlanaRecordingFixture({
    programId: process.env.PROGRAM_ID ?? 'modoitaliano',
    token: process.env.ALANA_CONTROL_TOKEN ?? '',
  });
  server.listen(port, '0.0.0.0', () => {
    process.stdout.write('Alana recording fixture ready\n');
  });
}
