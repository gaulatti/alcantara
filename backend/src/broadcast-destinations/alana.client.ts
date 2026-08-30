import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import type {
  DestinationSelectionPayload,
  SafeAlanaState,
  SafeDestinationMetadata,
  SafeDestinationState,
} from './broadcast-destinations.types';

export class AlanaRequestError extends Error {
  constructor(
    readonly status: number,
    readonly state: SafeAlanaState,
  ) {
    super(state.error ?? `Alana request failed with HTTP ${status}`);
  }
}

function safeString(value: unknown, fallback = 'unknown'): string {
  return typeof value === 'string' && value.length <= 200 ? value : fallback;
}

function safeMetadata(value: unknown): SafeDestinationMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const ids = Array.isArray(record.destinationIds)
    ? record.destinationIds.filter(
        (id): id is string => typeof id === 'string' && id.length <= 64,
      )
    : [];
  if (
    typeof record.version !== 'string' ||
    typeof record.selectionHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.selectionHash) ||
    typeof record.count !== 'number' ||
    record.count < 1 ||
    record.count > 20 ||
    ids.length !== record.count
  ) {
    return null;
  }
  return {
    version: record.version,
    selectionHash: record.selectionHash,
    count: record.count,
    destinationIds: ids,
  };
}

function safeDestinationStates(value: unknown): SafeDestinationState[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || record.id.length > 64) return [];
    return [
      {
        id: record.id,
        mode: safeString(record.mode),
        supervisorHealthy: record.supervisorHealthy === true,
        publisherProcessHealthy: record.publisherProcessHealthy === true,
      },
    ];
  });
}

export function sanitizeAlanaState(value: unknown): SafeAlanaState {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const acknowledgement =
    record.croccanteAcknowledgement &&
    typeof record.croccanteAcknowledgement === 'object' &&
    !Array.isArray(record.croccanteAcknowledgement)
      ? (record.croccanteAcknowledgement as Record<string, unknown>)
      : {};
  const command =
    record.commandResult &&
    typeof record.commandResult === 'object' &&
    !Array.isArray(record.commandResult)
      ? (record.commandResult as Record<string, unknown>)
      : null;
  return {
    requestedState: safeString(record.requestedState),
    actualState: safeString(record.actualState),
    transition:
      typeof record.transition === 'string' ? record.transition : null,
    readiness: record.readiness === true,
    lastSequence:
      typeof record.lastSequence === 'number' && record.lastSequence >= 0
        ? Math.floor(record.lastSequence)
        : 0,
    activeDestinations: safeMetadata(record.activeDestinations),
    pendingDestinations:
      safeMetadata(record.pendingDestinations) ?? safeMetadata(record),
    destinations: safeDestinationStates(acknowledgement.destinations),
    commandResult: command
      ? {
          action: safeString(command.action),
          result: safeString(command.result),
          status: typeof command.status === 'number' ? command.status : 0,
          sequence: typeof command.sequence === 'number' ? command.sequence : 0,
          ...(typeof command.destinationVersion === 'string'
            ? { destinationVersion: command.destinationVersion }
            : {}),
          ...(typeof command.destinationSelectionHash === 'string'
            ? {
                destinationSelectionHash: command.destinationSelectionHash,
              }
            : {}),
          ...(typeof command.destinationCount === 'number'
            ? { destinationCount: command.destinationCount }
            : {}),
        }
      : null,
    ...(typeof record.error === 'string'
      ? { error: safeString(record.error, 'downstream request failed') }
      : {}),
  };
}

@Injectable()
export class AlanaClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(
    config: ConfigService,
    private readonly metrics: ManagedMetricsService,
  ) {
    const environment = config.get<string>('NODE_ENV') ?? 'development';
    const configuredUrl =
      config.get<string>('ALANA_CONTROL_URL') ??
      (environment === 'test' ? 'http://alana.test:8080' : '');
    const configuredToken =
      config.get<string>('ALANA_CONTROL_TOKEN') ??
      (environment === 'test' ? 'alana-test-control-token' : '');
    this.baseUrl = normalizeAlanaBaseUrl(configuredUrl);
    this.token = configuredToken.trim();
    if (this.token.length < 16 || this.token.length > 4096) {
      throw new Error('ALANA_CONTROL_TOKEN is missing or invalid');
    }
  }

  status(programId: string): Promise<SafeAlanaState> {
    return this.request(
      programId,
      'status',
      `/v1/programs/${encodeURIComponent(programId)}/lifecycle`,
      { method: 'GET' },
    );
  }

  reload(
    programId: string,
    commandId: string,
    selection: DestinationSelectionPayload,
  ): Promise<SafeAlanaState> {
    return this.request(
      programId,
      'reload',
      `/v1/programs/${encodeURIComponent(programId)}/destinations/${encodeURIComponent(selection.version)}`,
      {
        method: 'PUT',
        headers: { 'Idempotency-Key': commandId },
        body: JSON.stringify({ commandId, ...selection }),
      },
    );
  }

  start(
    programId: string,
    commandId: string,
    sequence: number,
    selection: DestinationSelectionPayload,
  ): Promise<SafeAlanaState> {
    return this.request(
      programId,
      'start',
      `/v1/programs/${encodeURIComponent(programId)}/lifecycle/start`,
      {
        method: 'POST',
        headers: {
          'Idempotency-Key': commandId,
          'X-Command-Sequence': String(sequence),
        },
        body: JSON.stringify(selection),
      },
    );
  }

  stop(
    programId: string,
    commandId: string,
    sequence: number,
  ): Promise<SafeAlanaState> {
    return this.request(
      programId,
      'stop',
      `/v1/programs/${encodeURIComponent(programId)}/lifecycle/stop`,
      {
        method: 'POST',
        headers: {
          'Idempotency-Key': commandId,
          'X-Command-Sequence': String(sequence),
        },
      },
    );
  }

  private async request(
    _programId: string,
    operation: string,
    path: string,
    init: RequestInit,
  ): Promise<SafeAlanaState> {
    const started = process.hrtime.bigint();
    let result = 'failure';
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
      let payload: unknown = {};
      try {
        payload = await response.json();
      } catch {
        result = 'invalid-response';
        throw new AlanaRequestError(502, {
          ...sanitizeAlanaState({}),
          error: 'Alana returned an invalid response',
        });
      }
      const state = sanitizeAlanaState(payload);
      if (!response.ok) {
        result = 'http-error';
        throw new AlanaRequestError(response.status, state);
      }
      result = 'success';
      return state;
    } catch (error) {
      if (error instanceof AlanaRequestError) throw error;
      result = 'unavailable';
      throw new AlanaRequestError(503, {
        ...sanitizeAlanaState({}),
        error: 'Alana is unavailable',
      });
    } finally {
      this.metrics.recordDependency(
        'alana',
        operation,
        result,
        Number(process.hrtime.bigint() - started) / 1_000_000_000,
      );
    }
  }
}

export function normalizeAlanaBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('ALANA_CONTROL_URL is missing or invalid');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new Error('ALANA_CONTROL_URL is missing or invalid');
  }
  return parsed.origin;
}
