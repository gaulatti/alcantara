import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const token = process.env.ALANA_CONTROL_TOKEN ?? '';
const port = Number(process.env.PORT ?? '8080');
const programId = process.env.PROGRAM_ID ?? 'main';
let lastSequence = 0;
let requestedState = 'stopped';
let actualState = 'stopped';
let pendingDestinations = null;
let activeDestinations = null;
let lastCommand = null;
let nextStartMode = 'normal';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function metadata(selection) {
  return {
    version: selection.version,
    selectionHash: createHash('sha256').update(canonicalJson(selection)).digest('hex'),
    count: selection.destinations.length,
    destinationIds: selection.destinations.map((destination) => destination.id),
  };
}

function authorized(request) {
  const supplied = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  response.end(body);
}

function view() {
  return {
    programId,
    requestedState,
    actualState,
    transition: null,
    readiness: actualState === 'running',
    lastSequence,
    pendingDestinations,
    activeDestinations,
    lastCommand,
    croccanteAcknowledgement: activeDestinations ? {
      accepted: true,
      destinations: activeDestinations.destinationIds.map((id) => ({ id, mode: 'relaying', supervisorHealthy: true, publisherProcessHealthy: true })),
    } : null,
  };
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.reduce((total, chunk) => total + chunk.length, 0) > 65_536) throw new Error('oversized');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

createServer(async (request, response) => {
  if (request.url === '/health') return send(response, 200, { ok: true, fixture: 'alana-control' });
  if (!authorized(request)) return send(response, 401, { error: 'unauthorized' });
  if (request.method === 'POST' && request.url === '/__fixture/next-start') {
    const payload = await body(request);
    nextStartMode = payload.mode === 'partial' ? 'partial' : 'normal';
    return send(response, 200, { nextStartMode });
  }
  const lifecyclePath = `/v1/programs/${encodeURIComponent(programId)}/lifecycle`;
  if (request.method === 'GET' && request.url === lifecyclePath) return send(response, 200, view());
  try {
    if (request.method === 'PUT' && request.url?.startsWith(`/v1/programs/${encodeURIComponent(programId)}/destinations/`)) {
      if (actualState !== 'stopped' || requestedState !== 'stopped') return send(response, 409, { ...view(), error: 'destination reconfiguration requires a stopped broadcast' });
      const payload = await body(request);
      const selection = { version: payload.version, destinations: payload.destinations };
      pendingDestinations = metadata(selection);
      return send(response, 200, { ...pendingDestinations, result: 'validated', status: 200 });
    }
    if (request.method === 'POST' && request.url === `${lifecyclePath}/start`) {
      const sequence = Number(request.headers['x-command-sequence']);
      if (!Number.isInteger(sequence) || sequence <= lastSequence) return send(response, 409, { ...view(), error: 'command sequence is not newer' });
      const selection = await body(request);
      const next = metadata(selection);
      if (pendingDestinations && pendingDestinations.selectionHash !== next.selectionHash) return send(response, 409, { ...view(), error: 'pending destinations conflict' });
      requestedState = 'running';
      actualState = 'running';
      lastSequence = sequence;
      activeDestinations = next;
      pendingDestinations = null;
      lastCommand = { action: 'start', result: 'running', status: 200, sequence, destinationVersion: next.version, destinationSelectionHash: next.selectionHash, destinationCount: next.count };
      if (nextStartMode === 'partial') {
        nextStartMode = 'normal';
        activeDestinations = { ...next, selectionHash: '0'.repeat(64) };
      }
      return send(response, 200, { ...view(), commandResult: lastCommand });
    }
    if (request.method === 'POST' && request.url === `${lifecyclePath}/stop`) {
      const sequence = Number(request.headers['x-command-sequence']);
      if (!Number.isInteger(sequence) || sequence <= lastSequence) return send(response, 409, { ...view(), error: 'command sequence is not newer' });
      requestedState = 'stopped';
      actualState = 'stopped';
      lastSequence = sequence;
      pendingDestinations = activeDestinations;
      activeDestinations = null;
      lastCommand = { action: 'stop', result: 'stopped', status: 200, sequence };
      return send(response, 200, { ...view(), commandResult: lastCommand });
    }
  } catch {
    return send(response, 400, { error: 'invalid request' });
  }
  return send(response, 404, { error: 'not found' });
}).listen(port, '0.0.0.0', () => {
  process.stdout.write(`Alana local contract fixture listening on ${port}\n`);
});
