import { afterEach, expect, it, vi } from 'vitest';
import { callFailureReason, reportJoinFailure, roomIcePath, selectedIcePath } from './callTelemetry';

const report = (...stats: Array<Record<string, unknown> & { id: string }>) => new Map(stats.map((stat) => [stat.id, stat]));
const local = (candidateType: string, protocol: string) => ({ id: 'L', type: 'local-candidate', candidateType, protocol });
const pair = { id: 'P', type: 'candidate-pair', localCandidateId: 'L', nominated: true, state: 'succeeded' };
const transport = { id: 'T', type: 'transport', selectedCandidatePairId: 'P' };
const room = (...tracks: unknown[]) => ({
  localParticipant: { trackPublications: new Map(tracks.map((track, index) => [`t${index}`, { track: track as never }])) }
});

afterEach(() => vi.unstubAllGlobals());

it('names the selected pair’s path: relay, or direct udp or tcp', () => {
  expect(selectedIcePath(report(transport, pair, local('relay', 'udp')) as never)).toBe('relay');
  expect(selectedIcePath(report(transport, pair, local('srflx', 'udp')) as never)).toBe('udp');
  expect(selectedIcePath(report(transport, pair, local('host', 'tcp')) as never)).toBe('tcp');
  // Firefox: no transport stat, the pair is marked.
  expect(selectedIcePath(report({ ...pair, nominated: false, selected: true }, local('host', 'udp')) as never)).toBe('udp');
  expect(selectedIcePath(report(pair, local('host', 'udp')) as never)).toBe('udp');
  expect(selectedIcePath(report(transport, pair, local('host', 'ssltcp')) as never)).toBeNull();
  expect(selectedIcePath(report({ ...pair, state: 'failed' }, local('host', 'udp')) as never)).toBeNull();
  expect(selectedIcePath(report(transport, { id: 'P', type: 'candidate-pair' }) as never)).toBeNull();
});

it('reads the first track whose stats name a path, local or received', async () => {
  const good = { getRTCStatsReport: async () => report(transport, pair, local('relay', 'udp')) };
  const gone = {
    getRTCStatsReport: async () => {
      throw new Error('closed');
    }
  };
  const silent = { getRTCStatsReport: async () => undefined };
  expect(await roomIcePath(room(undefined, {}, gone, silent, good))).toBe('relay');
  expect(await roomIcePath({ remoteParticipants: new Map([['a', room(good).localParticipant]]) })).toBe('relay');
  expect(await roomIcePath(room(silent))).toBeNull();
  expect(await roomIcePath({ localParticipant: {} })).toBeNull();
  expect(await roomIcePath(null)).toBeNull();
});

it('sorts what getUserMedia and LiveKit throw into the counted reasons', () => {
  const named = (name: string, reasonName?: string) => callFailureReason({ name, reasonName });
  expect(named('NotAllowedError')).toBe('permission_denied');
  expect(named('SecurityError')).toBe('permission_denied');
  expect(named('NotFoundError')).toBe('no_device');
  expect(named('OverconstrainedError')).toBe('no_device');
  expect(named('ConnectionError', 'NotAllowed')).toBe('token_rejected');
  expect(named('ConnectionError', 'InternalError')).toBe('ice_failed');
  expect(named('ConnectionError', 'Timeout')).toBe('ice_failed');
  expect(named('ConnectionError', 'ServerUnreachable')).toBe('other');
  expect(callFailureReason(undefined)).toBe('other');
});

it('reports a failed join with the invitation, and drops a report it cannot send', async () => {
  const send = vi.fn().mockResolvedValue(new Response());
  vi.stubGlobal('fetch', send);
  await reportJoinFailure('inv.secret', { name: 'NotFoundError' });
  expect(send.mock.calls[0][0]).toContain('/webrtc/join/failure');
  expect(JSON.parse(send.mock.calls[0][1].body)).toEqual({ invitation: 'inv.secret', reason: 'no_device' });
  send.mockRejectedValueOnce(new Error('offline'));
  await expect(reportJoinFailure('inv.secret', null)).resolves.toBeUndefined();
});
