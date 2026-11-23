import {
  normalizeRecordingStatus,
  type RecordingStatus,
} from './recording.contract';

const base = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  state: 'idle',
  ...overrides,
});

describe('normalizeRecordingStatus coverage', () => {
  it.each([null, undefined, 'str', 4, [], [{}]])(
    'rejects non-record input %p',
    (value) => {
      expect(() => normalizeRecordingStatus(value)).toThrow(
        'invalid recording response',
      );
    },
  );

  it.each([
    ['enabled not boolean', { enabled: 'yes', state: 'idle' }],
    ['state not string', { enabled: true, state: 3 }],
    ['state unknown', { enabled: true, state: 'bogus' }],
    ['disabled flag with non-disabled state', base({ enabled: false })],
    ['disabled state with enabled flag', base({ state: 'disabled' })],
    [
      'complete without verified finalization',
      base({
        state: 'complete',
        finalBytes: 5,
        finalizedAt: '2026-01-01T00:00:00Z',
      }),
    ],
    [
      'complete without final bytes',
      base({
        state: 'complete',
        finalizationState: 'verified',
        finalizedAt: '2026-01-01T00:00:00Z',
      }),
    ],
    [
      'complete without finalizedAt',
      base({
        state: 'complete',
        finalizationState: 'verified',
        finalBytes: 5,
      }),
    ],
  ])('rejects %s', (_name, value) => {
    expect(() => normalizeRecordingStatus(value)).toThrow(
      'invalid recording response',
    );
  });

  it('applies defaults for a minimal valid status', () => {
    expect(normalizeRecordingStatus(base())).toEqual({
      enabled: true,
      state: 'idle',
      requestedAt: null,
      startedAt: null,
      stoppedAt: null,
      finalizedAt: null,
      updatedAt: null,
      segmentCount: 0,
      bytes: 0,
      durationSeconds: 0,
      droppedFrames: 0,
      errors: 0,
      restarts: 0,
      finalizationState: 'not-requested',
      finalBytes: 0,
      error: null,
      disk: null,
    } satisfies RecordingStatus);
  });

  it('accepts a disabled status and a verified complete status', () => {
    expect(
      normalizeRecordingStatus({ enabled: false, state: 'disabled' }).state,
    ).toBe('disabled');
    const complete = normalizeRecordingStatus(
      base({
        state: 'complete',
        finalizationState: 'verified',
        finalBytes: 10,
        finalizedAt: '2026-01-01T00:00:00Z',
      }),
    );
    expect(complete).toMatchObject({
      state: 'complete',
      finalizationState: 'verified',
      finalBytes: 10,
      finalizedAt: '2026-01-01T00:00:00Z',
    });
  });

  it('sanitizes numbers, timestamps, finalization state and errors', () => {
    const result = normalizeRecordingStatus(
      base({
        segmentCount: -1,
        bytes: Number.NaN,
        durationSeconds: '5',
        droppedFrames: Infinity,
        errors: 3,
        restarts: 0,
        requestedAt: 'not a date',
        startedAt: 'x'.repeat(41),
        stoppedAt: 12,
        updatedAt: '2026-01-01T00:00:00Z',
        finalizationState: 'weird',
        error: 'capture-failed',
      }),
    );
    expect(result).toMatchObject({
      segmentCount: 0,
      bytes: 0,
      durationSeconds: 0,
      droppedFrames: 0,
      errors: 3,
      requestedAt: null,
      startedAt: null,
      stoppedAt: null,
      updatedAt: '2026-01-01T00:00:00Z',
      finalizationState: 'not-requested',
      error: 'capture-failed',
    });
    expect(normalizeRecordingStatus(base({ error: '/etc/passwd' })).error).toBe(
      'unknown',
    );
    expect(
      normalizeRecordingStatus(base({ finalizationState: 'pending' }))
        .finalizationState,
    ).toBe('pending');
  });

  it('normalizes disk records and rejects non-record disk values', () => {
    expect(
      normalizeRecordingStatus(
        base({ disk: { freeBytes: 1, usageBytes: -2, quotaBytes: 'x' } }),
      ).disk,
    ).toEqual({
      freeBytes: 1,
      usageBytes: 0,
      quotaBytes: 0,
      minimumFreeBytes: 0,
    });
    expect(normalizeRecordingStatus(base({ disk: [] })).disk).toBeNull();
    expect(normalizeRecordingStatus(base({ disk: 'x' })).disk).toBeNull();
  });

  it('keeps a bounded command result', () => {
    expect(
      normalizeRecordingStatus(
        base({
          commandResult: {
            action: 'stop',
            status: 200,
            result: 'not-active',
            duplicate: true,
          },
        }),
      ).commandResult,
    ).toEqual({
      action: 'stop',
      status: 200,
      result: 'not-active',
      duplicate: true,
    });
    expect(
      normalizeRecordingStatus(
        base({
          commandResult: { action: 'start', status: 202, result: 'leak /x' },
        }),
      ).commandResult,
    ).toEqual({
      action: 'start',
      status: 202,
      result: 'unknown',
      duplicate: false,
    });
    expect(
      normalizeRecordingStatus(
        base({ commandResult: { action: 'start', status: 202, result: 5 } }),
      ).commandResult?.result,
    ).toBe('unknown');
  });

  it.each([
    ['falsy', null],
    ['an array', []],
    ['a string', 'x'],
    ['bad action', { action: 'pause', status: 200, result: 'accepted' }],
    ['non-numeric status', { action: 'start', status: '200', result: 'x' }],
  ])('omits commandResult when it is %s', (_name, commandResult) => {
    expect(
      normalizeRecordingStatus(base({ commandResult })),
    ).not.toHaveProperty('commandResult');
  });
});
