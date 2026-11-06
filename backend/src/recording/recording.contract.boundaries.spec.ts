import {
  normalizeRecordingStatus,
  RECORDING_FAILURE_REASONS,
} from './recording.contract';

const timestamp = '2026-10-24T12:00:00Z';
const status = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  state: 'active',
  finalizationState: 'not-requested',
  ...overrides,
});

describe('recording wire state consistency and bounded evidence', () => {
  it.each([null, [], false, 4, 'recording'].map((value) => [value]))(
    'rejects a non-record state %j',
    (value) => {
      expect(() => normalizeRecordingStatus(value)).toThrow(
        'invalid recording response',
      );
    },
  );

  it.each([
    { enabled: 1 },
    { state: 4 },
    { state: 'unknown' },
    { enabled: false, state: 'active' },
    { enabled: true, state: 'disabled' },
    {
      state: 'complete',
      finalizationState: 'pending',
      finalBytes: 4,
      finalizedAt: timestamp,
    },
    {
      state: 'complete',
      finalizationState: 'verified',
      finalBytes: 0,
      finalizedAt: timestamp,
    },
    {
      state: 'complete',
      finalizationState: 'verified',
      finalBytes: 4,
      finalizedAt: null,
    },
  ])('rejects contradictory recording state %j', (override) => {
    expect(() => normalizeRecordingStatus(status(override))).toThrow(
      'invalid recording response',
    );
  });

  it('accepts disabled and verified complete states only with their required invariants', () => {
    expect(
      normalizeRecordingStatus(status({ enabled: false, state: 'disabled' })),
    ).toMatchObject({ enabled: false, state: 'disabled' });
    expect(
      normalizeRecordingStatus(
        status({
          state: 'complete',
          finalizationState: 'verified',
          finalBytes: 4,
          finalizedAt: timestamp,
        }),
      ),
    ).toMatchObject({
      state: 'complete',
      finalBytes: 4,
      finalizedAt: timestamp,
    });
  });

  it.each(['not-requested', 'pending', 'verified', 'failed'])(
    'retains known finalization state %s',
    (finalizationState) => {
      expect(
        normalizeRecordingStatus(status({ finalizationState }))
          .finalizationState,
      ).toBe(finalizationState);
    },
  );

  it.each(['unrecognized', 4, null].map((value) => [value]))(
    'does not invent finalization from malformed value %j',
    (finalizationState) => {
      expect(
        normalizeRecordingStatus(status({ finalizationState }))
          .finalizationState,
      ).toBe('not-requested');
    },
  );

  it.each([undefined, null, -1, NaN, Infinity, '5'].map((value) => [value]))(
    'normalizes untrusted numeric and disk counters %j',
    (value) => {
      const result = normalizeRecordingStatus(
        status({
          segmentCount: value,
          bytes: value,
          durationSeconds: value,
          droppedFrames: value,
          errors: value,
          restarts: value,
          finalBytes: value,
          disk: {
            freeBytes: value,
            usageBytes: value,
            quotaBytes: value,
            minimumFreeBytes: value,
          },
        }),
      );
      expect(result).toMatchObject({
        segmentCount: 0,
        bytes: 0,
        durationSeconds: 0,
        droppedFrames: 0,
        errors: 0,
        restarts: 0,
        finalBytes: 0,
        disk: {
          freeBytes: 0,
          usageBytes: 0,
          quotaBytes: 0,
          minimumFreeBytes: 0,
        },
      });
    },
  );

  it.each([null, [], 'disk', 4].map((value) => [value]))(
    'omits non-record disk information %j',
    (disk) => {
      expect(normalizeRecordingStatus(status({ disk })).disk).toBeNull();
    },
  );

  it.each(
    [undefined, 4, 'not a timestamp', 'x'.repeat(41)].map((value) => [value]),
  )('does not expose malformed timestamps %j', (value) => {
    expect(
      normalizeRecordingStatus(
        status({
          requestedAt: value,
          startedAt: value,
          stoppedAt: value,
          finalizedAt: value,
          updatedAt: value,
        }),
      ),
    ).toMatchObject({
      requestedAt: null,
      startedAt: null,
      stoppedAt: null,
      finalizedAt: null,
      updatedAt: null,
    });
  });

  it.each(RECORDING_FAILURE_REASONS)(
    'retains only known failure reason %s',
    (error) => {
      expect(normalizeRecordingStatus(status({ error })).error).toBe(error);
    },
  );

  it('redacts unknown failure text while preserving nullable errors and finite measurements', () => {
    expect(
      normalizeRecordingStatus(status({ error: 'private diagnostic' })).error,
    ).toBe('unknown');
    expect(normalizeRecordingStatus(status({ error: 4 })).error).toBeNull();
    expect(
      normalizeRecordingStatus(
        status({
          requestedAt: timestamp,
          segmentCount: 2,
          disk: {
            freeBytes: 2,
            usageBytes: 3,
            quotaBytes: 4,
            minimumFreeBytes: 1,
          },
        }),
      ),
    ).toMatchObject({
      requestedAt: timestamp,
      segmentCount: 2,
      disk: { freeBytes: 2, usageBytes: 3, quotaBytes: 4, minimumFreeBytes: 1 },
    });
  });

  it.each(
    [
      null,
      [],
      false,
      'command',
      { action: 'restart', status: 200 },
      { action: 'start', status: '200' },
    ].map((value) => [value]),
  )('ignores malformed optional command evidence %j', (commandResult) => {
    expect(
      normalizeRecordingStatus(status({ commandResult })),
    ).not.toHaveProperty('commandResult');
  });

  it.each(['start', 'stop'])(
    'retains bounded %s command evidence and redacts arbitrary result text',
    (action) => {
      expect(
        normalizeRecordingStatus(
          status({
            commandResult: {
              action,
              status: 202,
              result: 'accepted',
              duplicate: true,
            },
          }),
        ).commandResult,
      ).toEqual({ action, status: 202, result: 'accepted', duplicate: true });
      expect(
        normalizeRecordingStatus(
          status({
            commandResult: {
              action,
              status: 503,
              result: 'private endpoint',
              duplicate: false,
            },
          }),
        ).commandResult,
      ).toEqual({ action, status: 503, result: 'unknown', duplicate: false });
      expect(
        normalizeRecordingStatus(
          status({ commandResult: { action, status: 202, result: 4 } }),
        ).commandResult?.result,
      ).toBe('unknown');
    },
  );
});
