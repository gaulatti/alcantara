export const RECORDING_STATES = [
  'disabled',
  'idle',
  'requested',
  'active',
  'finalizing',
  'complete',
  'failed',
] as const;

export type RecordingState = (typeof RECORDING_STATES)[number];

export const RECORDING_FAILURE_REASONS = [
  'disk-exhausted',
  'quota-exhausted',
  'capture-failed',
  'restart-exhausted',
  'manifest-corrupt',
  'segment-corrupt',
  'finalize-failed',
  'final-artifact-invalid',
] as const;

export type RecordingFailureReason =
  | (typeof RECORDING_FAILURE_REASONS)[number]
  | 'unknown';

export type RecordingStatus = {
  enabled: boolean;
  state: RecordingState;
  requestedAt: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  finalizedAt: string | null;
  updatedAt: string | null;
  segmentCount: number;
  bytes: number;
  durationSeconds: number;
  droppedFrames: number;
  errors: number;
  restarts: number;
  finalizationState: 'not-requested' | 'pending' | 'verified' | 'failed';
  finalBytes: number;
  error: RecordingFailureReason | null;
  disk: {
    freeBytes: number;
    usageBytes: number;
    quotaBytes: number;
    minimumFreeBytes: number;
  } | null;
  commandResult?: {
    action: 'start' | 'stop';
    status: number;
    result: string;
    duplicate: boolean;
  };
};

const stateSet = new Set<string>(RECORDING_STATES);
const failureSet = new Set<string>(RECORDING_FAILURE_REASONS);
const finalizationSet = new Set([
  'not-requested',
  'pending',
  'verified',
  'failed',
]);
const commandResults = new Set([
  'accepted',
  'complete',
  'failed',
  'disabled',
  'already-active',
  'not-active',
  'pipeline-not-ready',
  ...RECORDING_FAILURE_REASONS,
]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid recording response');
  }
  return value as Record<string, unknown>;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function nullableTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? value : null;
}

function normalizeDisk(value: unknown): RecordingStatus['disk'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return {
    freeBytes: nonNegativeNumber(candidate.freeBytes),
    usageBytes: nonNegativeNumber(candidate.usageBytes),
    quotaBytes: nonNegativeNumber(candidate.quotaBytes),
    minimumFreeBytes: nonNegativeNumber(candidate.minimumFreeBytes),
  };
}

export function normalizeRecordingStatus(value: unknown): RecordingStatus {
  const candidate = record(value);
  if (
    typeof candidate.enabled !== 'boolean' ||
    typeof candidate.state !== 'string' ||
    !stateSet.has(candidate.state)
  ) {
    throw new Error('invalid recording response');
  }
  const finalizationState =
    typeof candidate.finalizationState === 'string' &&
    finalizationSet.has(candidate.finalizationState)
      ? (candidate.finalizationState as RecordingStatus['finalizationState'])
      : 'not-requested';
  const error =
    typeof candidate.error === 'string'
      ? failureSet.has(candidate.error)
        ? (candidate.error as RecordingFailureReason)
        : 'unknown'
      : null;
  const status: RecordingStatus = {
    enabled: candidate.enabled,
    state: candidate.state as RecordingState,
    requestedAt: nullableTimestamp(candidate.requestedAt),
    startedAt: nullableTimestamp(candidate.startedAt),
    stoppedAt: nullableTimestamp(candidate.stoppedAt),
    finalizedAt: nullableTimestamp(candidate.finalizedAt),
    updatedAt: nullableTimestamp(candidate.updatedAt),
    segmentCount: nonNegativeNumber(candidate.segmentCount),
    bytes: nonNegativeNumber(candidate.bytes),
    durationSeconds: nonNegativeNumber(candidate.durationSeconds),
    droppedFrames: nonNegativeNumber(candidate.droppedFrames),
    errors: nonNegativeNumber(candidate.errors),
    restarts: nonNegativeNumber(candidate.restarts),
    finalizationState,
    finalBytes: nonNegativeNumber(candidate.finalBytes),
    error,
    disk: normalizeDisk(candidate.disk),
  };
  if (
    (status.enabled === false && status.state !== 'disabled') ||
    (status.state === 'disabled' && status.enabled !== false) ||
    (status.state === 'complete' &&
      (status.finalizationState !== 'verified' ||
        status.finalBytes <= 0 ||
        status.finalizedAt === null))
  ) {
    throw new Error('invalid recording response');
  }
  if (
    candidate.commandResult &&
    typeof candidate.commandResult === 'object' &&
    !Array.isArray(candidate.commandResult)
  ) {
    const command = candidate.commandResult as Record<string, unknown>;
    if (
      (command.action === 'start' || command.action === 'stop') &&
      typeof command.status === 'number'
    ) {
      status.commandResult = {
        action: command.action,
        status: command.status,
        result:
          typeof command.result === 'string' &&
          commandResults.has(command.result)
            ? command.result
            : 'unknown',
        duplicate: command.duplicate === true,
      };
    }
  }
  return status;
}
