import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchRecordingStatus,
  newRecordingCommandKey,
  RecordingApiError,
  sendRecordingCommand,
} from './recording';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./api', () => ({ authFetch: request }));

afterEach(() => vi.resetAllMocks());

describe('recording control transport', () => {
  it('reads the authoritative status for an encoded program identifier', async () => {
    const status = { state: 'active', bytes: 4096, segmentCount: 2 };
    request.mockResolvedValue(new Response(JSON.stringify(status)));
    await expect(fetchRecordingStatus('show/a b')).resolves.toEqual(status);
    expect(request).toHaveBeenCalledWith('/program/show%2Fa%20b/recording');
  });

  it.each(['start', 'stop'] as const)('sends %s with the caller idempotency key', async (action) => {
    const status = { state: action === 'start' ? 'requested' : 'finalizing' };
    request.mockResolvedValue(new Response(JSON.stringify(status)));
    await expect(sendRecordingCommand('main', action, 'operator-attempt-1')).resolves.toEqual(status);
    expect(request).toHaveBeenCalledWith(`/program/main/recording/${action}`, {
      method: 'POST', headers: { 'Idempotency-Key': 'operator-attempt-1' },
    });
  });

  it.each([
    [403, { reason: 'disk-exhausted' }, 'You do not have permission to operate recording.'],
    [401, { reason: 'capture-failed' }, 'Your session is no longer authorized.'],
    [409, { reason: 'pipeline-not-ready' }, 'Alana is not ready to record the composed program.'],
    [409, { reason: 'disabled' }, 'Recording is disabled in Alana.'],
    [409, { reason: 'already-active' }, 'A recording is already active or finalizing.'],
    [409, { reason: 'not-active' }, 'There is no active recording to stop.'],
    [507, { reason: 'disk-exhausted' }, 'Alana does not have enough free disk space.'],
    [507, { reason: 'quota-exhausted' }, 'Alana has reached its recording storage quota.'],
    [502, { reason: 'capture-failed' }, 'Alana could not capture the composed program.'],
    [502, { reason: 'restart-exhausted' }, 'Alana exhausted its recording restart budget.'],
    [502, { reason: 'manifest-corrupt' }, 'Alana could not verify the recording manifest.'],
    [502, { reason: 'segment-corrupt' }, 'Alana found a corrupt recording segment.'],
    [502, { reason: 'finalize-failed' }, 'Alana could not finalize the recording.'],
    [502, { reason: 'final-artifact-invalid' }, 'Alana could not verify the final recording.'],
    [503, { reason: 'unknown' }, 'Recording control is temporarily unavailable.'],
    [400, { reason: 123 }, 'The recording command was rejected.'],
    [400, null, 'The recording command was rejected.'],
  ])('preserves HTTP %i as a recording failure with an operator explanation', async (status, payload, message) => {
    request.mockResolvedValue(new Response(JSON.stringify(payload), { status }));
    const error = await fetchRecordingStatus('main').catch((error: unknown) => error);
    expect(error).toBeInstanceOf(RecordingApiError);
    expect(error).toMatchObject({ status, message });
  });

  it('reports a non-JSON backend failure instead of claiming recording success', async () => {
    request.mockResolvedValue(new Response('upstream unavailable', { status: 502 }));
    await expect(fetchRecordingStatus('main')).rejects.toMatchObject({
      status: 502, message: 'Recording control is temporarily unavailable.',
    });
  });

  it.each([null, 'active', {}, { state: 1 }])('rejects malformed successful status %j', async (payload) => {
    request.mockResolvedValue(new Response(JSON.stringify(payload)));
    await expect(fetchRecordingStatus('main')).rejects.toMatchObject({
      status: 502, message: 'Recording control returned an invalid response.',
    });
  });

  it('rejects a successful non-JSON status', async () => {
    request.mockResolvedValue(new Response('not JSON'));
    await expect(fetchRecordingStatus('main')).rejects.toBeInstanceOf(RecordingApiError);
  });

  it('propagates network failure without manufacturing a status', async () => {
    request.mockRejectedValue(new Error('offline'));
    await expect(fetchRecordingStatus('main')).rejects.toThrow('offline');
  });

  it('creates distinct action-scoped command keys', () => {
    const first = newRecordingCommandKey('start');
    const second = newRecordingCommandKey('start');
    expect(first).toMatch(/^alcantara-recording-start-[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
    expect(newRecordingCommandKey('stop')).toMatch(/^alcantara-recording-stop-/);
  });
});
