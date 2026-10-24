import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateFlightSequence, createFlightSequence, deactivateFlightSequence, deleteFlightSequence,
  fetchFlightSequences, fillRundown, generateTaggedLog, goFlight, preflightFlightSequence,
  publishFlightSequence, resetFlight, startFlight, stopFlight, updateFlightSequence,
} from './flight';

vi.mock('../utils/apiBaseUrl', () => ({ apiUrl: (path: string) => `https://api.example${path}` }));
afterEach(() => vi.unstubAllGlobals());

const prefix = '/program/show%2Fa/flight';
const sequence = { id: 7, name: 'Morning rundown', revision: 3, items: [] };
const rules = { labelId: 'filler', artistSeparation: 2 };
const logRules = { slots: [{ labelId: 'songs', count: 2 }], artistSeparation: 2 };
const jsonRequest = (method: string, body: object) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const cases = [
  { name: 'list', run: () => fetchFlightSequences('show/a'), path: prefix, init: undefined, payload: [sequence] },
  { name: 'create', run: () => createFlightSequence('show/a', { name: 'Morning rundown', items: [], loop: false, scheduledAt: null }), path: prefix, init: jsonRequest('POST', { name: 'Morning rundown', items: [], loop: false, scheduledAt: null }), payload: sequence },
  { name: 'update', run: () => updateFlightSequence('show/a', 7, { name: 'Updated', revision: 3 }), path: `${prefix}/7`, init: jsonRequest('PUT', { name: 'Updated', revision: 3 }), payload: { ...sequence, name: 'Updated', revision: 4 } },
  { name: 'delete', run: () => deleteFlightSequence('show/a', 7), path: `${prefix}/7`, init: { method: 'DELETE' }, payload: { deletedId: 7 } },
  { name: 'activate', run: () => activateFlightSequence('show/a', 7), path: `${prefix}/7/activate`, init: { method: 'POST' }, payload: { activeSequenceId: 7 } },
  { name: 'deactivate', run: () => deactivateFlightSequence('show/a'), path: `${prefix}/deactivate`, init: { method: 'POST' }, payload: { activeSequenceId: null } },
  { name: 'start', run: () => startFlight('show/a'), path: `${prefix}/start`, init: { method: 'POST' }, payload: { ok: true } },
  { name: 'stop', run: () => stopFlight('show/a'), path: `${prefix}/stop`, init: { method: 'POST' }, payload: { ok: true } },
  { name: 'go', run: () => goFlight('show/a'), path: `${prefix}/go`, init: { method: 'POST' }, payload: { ok: true } },
  { name: 'reset', run: () => resetFlight('show/a'), path: `${prefix}/reset`, init: { method: 'POST' }, payload: { ok: true } },
  { name: 'preflight', run: () => preflightFlightSequence('show/a', 7), path: `${prefix}/7/preflight`, init: undefined, payload: { ready: false, issues: ['Missing song'] } },
  { name: 'publish', run: () => publishFlightSequence('show/a', 7, 3), path: `${prefix}/7/publish`, init: jsonRequest('POST', { revision: 3 }), payload: sequence },
  { name: 'fill', run: () => fillRundown('show/a', 7, 3, [], rules), path: `${prefix}/7/fill`, init: jsonRequest('POST', { revision: 3, items: [], rules }), payload: { items: [], warnings: ['No eligible fillers'] } },
  { name: 'generate', run: () => generateTaggedLog('show/a', 7, 3, logRules), path: `${prefix}/7/generate`, init: jsonRequest('POST', { revision: 3, rules: logRules }), payload: { items: [] } },
];

describe('rundown API contract', () => {
  it.each(cases)('$name preserves program scope, method, payload and authoritative response', async ({ run, path, init, payload }) => {
    const request = vi.fn(async () => new Response(JSON.stringify(payload)));
    vi.stubGlobal('fetch', request);
    await expect(run()).resolves.toEqual(payload);
    expect(request).toHaveBeenCalledWith(`https://api.example${path}`, ...(init === undefined ? [] : [init]));
  });
  it.each(cases)('$name rejects a failed operation with the backend reason', async ({ run }) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Revision conflict' }), { status: 409 })));
    await expect(run()).rejects.toThrow('Revision conflict');
  });
  it.each([
    [JSON.stringify({ message: ['Missing scene', 'Missing song'] }), 'Missing scene; Missing song'],
    [JSON.stringify({ message: 123 }), 'Rundown request failed (502)'],
    [JSON.stringify(null), 'Rundown request failed (502)'],
    [JSON.stringify('failure'), 'Rundown request failed (502)'],
    ['not JSON', 'Rundown request failed (502)'],
  ])('retains a useful explanation for error body %s', async (body, message) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 502 })));
    await expect(startFlight('main')).rejects.toThrow(message);
  });
});
