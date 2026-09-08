import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { URL } from 'node:url';

const port = Number(process.env.PORT ?? '8080');
const recordingProgramId = process.env.PROGRAM_ID ?? 'modoitaliano';
const destinationProgramId = process.env.DESTINATION_PROGRAM_ID ?? 'main';
const token = process.env.ALANA_CONTROL_TOKEN ?? '';
const recordingBasePath = `/v1/programs/${encodeURIComponent(recordingProgramId)}/recording`;
const lifecycleBasePath = `/v1/programs/${encodeURIComponent(destinationProgramId)}/lifecycle`;
const commands = new Map();
let lastSequence = 0;
let requestedBroadcastState = 'stopped';
let actualBroadcastState = 'stopped';
let pendingDestinations = null;
let activeDestinations = null;
let lastBroadcastCommand = null;
let nextStartMode = 'normal';

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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function destinationMetadata(selection) {
  return {
    version: selection.version,
    selectionHash: createHash('sha256')
      .update(canonicalJson(selection))
      .digest('hex'),
    count: selection.destinations.length,
    destinationIds: selection.destinations.map((destination) => destination.id),
  };
}

function broadcastView() {
  return {
    programId: destinationProgramId,
    requestedState: requestedBroadcastState,
    actualState: actualBroadcastState,
    transition: null,
    readiness: actualBroadcastState === 'running',
    lastSequence,
    pendingDestinations,
    activeDestinations,
    lastCommand: lastBroadcastCommand,
    croccanteAcknowledgement: activeDestinations
      ? {
          accepted: true,
          destinations: activeDestinations.destinationIds.map((id) => ({
            id,
            mode: 'relaying',
            supervisorHealthy: true,
            publisherProcessHealthy: true,
          })),
        }
      : null,
  };
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.reduce((total, chunk) => total + chunk.length, 0) > 65_536) {
    throw new Error('oversized');
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

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

createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://fixture').pathname;
  if (request.method === 'GET' && path === '/health') {
    send(response, 200, { status: 'ok' });
    return;
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    send(response, 401, { error: 'unauthorized' });
    return;
  }
  if (request.method === 'GET' && path === recordingBasePath) {
    send(response, 200, state);
    return;
  }
  if (
    request.method === 'POST' &&
    (path === `${recordingBasePath}/start` ||
      path === `${recordingBasePath}/stop`)
  ) {
    const key = String(request.headers['idempotency-key'] ?? '');
    if (!key || key.length > 200) {
      send(response, 400, { error: 'idempotency-key-required' });
      return;
    }
    command(response, path.endsWith('/start') ? 'start' : 'stop', key);
    return;
  }
  if (request.method === 'POST' && path === '/__fixture/next-start') {
    try {
      const payload = await requestBody(request);
      nextStartMode = payload.mode === 'partial' ? 'partial' : 'normal';
      send(response, 200, { nextStartMode });
    } catch {
      send(response, 400, { error: 'invalid-request' });
    }
    return;
  }
  if (request.method === 'GET' && path === lifecycleBasePath) {
    send(response, 200, broadcastView());
    return;
  }
  try {
    if (
      request.method === 'PUT' &&
      path.startsWith(
        `/v1/programs/${encodeURIComponent(destinationProgramId)}/destinations/`,
      )
    ) {
      if (
        actualBroadcastState !== 'stopped' ||
        requestedBroadcastState !== 'stopped'
      ) {
        send(response, 409, {
          ...broadcastView(),
          error: 'destination reconfiguration requires a stopped broadcast',
        });
        return;
      }
      const payload = await requestBody(request);
      pendingDestinations = destinationMetadata({
        version: payload.version,
        destinations: payload.destinations,
      });
      send(response, 200, {
        ...pendingDestinations,
        result: 'validated',
        status: 200,
      });
      return;
    }
    if (
      request.method === 'POST' &&
      (path === `${lifecycleBasePath}/start` ||
        path === `${lifecycleBasePath}/stop`)
    ) {
      const sequence = Number(request.headers['x-command-sequence']);
      if (!Number.isInteger(sequence) || sequence <= lastSequence) {
        send(response, 409, {
          ...broadcastView(),
          error: 'command sequence is not newer',
        });
        return;
      }
      if (path.endsWith('/stop')) {
        requestedBroadcastState = 'stopped';
        actualBroadcastState = 'stopped';
        lastSequence = sequence;
        pendingDestinations = activeDestinations;
        activeDestinations = null;
        lastBroadcastCommand = {
          action: 'stop',
          result: 'stopped',
          status: 200,
          sequence,
        };
        send(response, 200, {
          ...broadcastView(),
          commandResult: lastBroadcastCommand,
        });
        return;
      }
      const selection = await requestBody(request);
      const next = destinationMetadata(selection);
      if (
        pendingDestinations &&
        pendingDestinations.selectionHash !== next.selectionHash
      ) {
        send(response, 409, {
          ...broadcastView(),
          error: 'pending destinations conflict',
        });
        return;
      }
      requestedBroadcastState = 'running';
      actualBroadcastState = 'running';
      lastSequence = sequence;
      activeDestinations = next;
      pendingDestinations = null;
      lastBroadcastCommand = {
        action: 'start',
        result: 'running',
        status: 200,
        sequence,
        destinationVersion: next.version,
        destinationSelectionHash: next.selectionHash,
        destinationCount: next.count,
      };
      if (nextStartMode === 'partial') {
        nextStartMode = 'normal';
        activeDestinations = { ...next, selectionHash: '0'.repeat(64) };
      }
      send(response, 200, {
        ...broadcastView(),
        commandResult: lastBroadcastCommand,
      });
      return;
    }
  } catch {
    send(response, 400, { error: 'invalid-request' });
    return;
  }
  send(response, 404, { error: 'not-found' });
}).listen(port, '0.0.0.0', () => {
  process.stdout.write('Alana recording and destination fixture ready\n');
});
