import { createServer } from 'node:http';
import { URL } from 'node:url';

const port = Number(process.env.PORT ?? '8080');
const programId = process.env.PROGRAM_ID ?? 'modoitaliano';
const token = process.env.ALANA_CONTROL_TOKEN ?? '';
const basePath = `/v1/programs/${encodeURIComponent(programId)}/recording`;
const commands = new Map();

const timestamp = () => new Date().toISOString();
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
    setTimeout(() => {
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
    }, 250);
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
  setTimeout(() => {
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
  }, 250);
}

createServer((request, response) => {
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
}).listen(port, '0.0.0.0', () => {
  process.stdout.write('Alana recording fixture ready\n');
});
