import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  canonicalJson,
  type DestinationSelectionPayload,
  type SafeAlanaFiller,
  type SafeAlanaState,
  type SafeDestinationMetadata,
  type SafeDestinationState,
  type TelevisionLiveProfile,
} from './broadcast-destinations.types';
import { createHash } from 'node:crypto';

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

const SHA256 = /^[0-9a-f]{64}$/;
const PROFILE_KEYS = [
  'audioBitrate',
  'audioChannels',
  'audioRate',
  'fps',
  'gop',
  'height',
  'loopSeconds',
  'videoBitrate',
  'width',
] as const;
const STRING_PROFILE_KEYS = new Set(['audioBitrate', 'videoBitrate']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A filler acknowledgement reduced to the fields Alcantara binds against
 * (pinned contract for gaulatti/alcantara#126). `profileChecksum` is present
 * only from an Alana that implements gaulatti/alana#29.
 */
export function sanitizeAlanaFiller(value: unknown): SafeAlanaFiller | null {
  const record = asRecord(value);
  if (!record || typeof record.version !== 'string') return null;
  return {
    version: safeString(record.version),
    status: safeString(record.status),
    ready: record.ready === true,
    ...(typeof record.sourceId === 'string' && record.sourceId.length <= 200
      ? { sourceId: record.sourceId }
      : {}),
    ...(typeof record.sourceSha256 === 'string' &&
    SHA256.test(record.sourceSha256)
      ? { sourceSha256: record.sourceSha256 }
      : {}),
    ...(typeof record.profileChecksum === 'string' &&
    SHA256.test(record.profileChecksum)
      ? { profileChecksum: record.profileChecksum }
      : {}),
  };
}

/** The checksum of a live profile: SHA-256 of its canonical JSON. */
export function liveProfileChecksum(profile: TelevisionLiveProfile): string {
  return createHash('sha256').update(canonicalJson(profile)).digest('hex');
}

/**
 * A complete, self-consistent live-profile response, or null.
 *
 * Every known key must be present and valid. A profile key Alcantara does not
 * know is not a reason to refuse the profile (gaulatti/ariston#217): the
 * checksum is computed over the profile exactly as received, so integrity
 * still holds, and that same profile is what Alcantara forwards to Alana when
 * it prepares a filler. `onUnknownKey` is called once per such key.
 * `contractVersion`, `programId` and checksum equality stay strict.
 */
export function parseLiveProfile(
  value: unknown,
  programId: string,
  onUnknownKey?: () => void,
): { profile: TelevisionLiveProfile; checksum: string } | null {
  const record = asRecord(value);
  const profile = asRecord(record?.profile);
  if (
    !record ||
    !profile ||
    record.contractVersion !== 1 ||
    record.programId !== programId ||
    typeof record.checksum !== 'string' ||
    PROFILE_KEYS.some((key) =>
      STRING_PROFILE_KEYS.has(key)
        ? typeof profile[key] !== 'string' ||
          !/^[1-9][0-9]{0,6}k$/.test(profile[key])
        : !Number.isInteger(profile[key]) || (profile[key] as number) < 1,
    )
  ) {
    return null;
  }
  const parsed = profile as unknown as TelevisionLiveProfile;
  if (liveProfileChecksum(parsed) !== record.checksum) return null;
  const known: ReadonlySet<string> = new Set(PROFILE_KEYS);
  for (const key of Object.keys(profile)) {
    if (!known.has(key)) onUnknownKey?.();
  }
  return { profile: parsed, checksum: record.checksum };
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
  const activeFiller = sanitizeAlanaFiller(record.activeFiller);
  const pendingFiller = sanitizeAlanaFiller(record.pendingFiller);
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
    ...(activeFiller ? { activeFiller } : {}),
    ...(pendingFiller ? { pendingFiller } : {}),
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

  /**
   * The renderer's effective live profile (gaulatti/alana#29), or null when
   * this Alana does not publish one (404).
   */
  async liveProfile(
    programId: string,
  ): Promise<{ profile: TelevisionLiveProfile; checksum: string } | null> {
    let payload: unknown;
    try {
      payload = await this.request(
        programId,
        'profile',
        `/v1/programs/${encodeURIComponent(programId)}/live-profile`,
        { method: 'GET' },
        (body) => body,
      );
    } catch (error) {
      if (error instanceof AlanaRequestError && error.status === 404)
        return null;
      throw error;
    }
    const parsed = parseLiveProfile(payload, programId, () =>
      this.metrics.recordAlanaLiveProfileUnknownKey(),
    );
    if (!parsed) {
      throw new AlanaRequestError(502, {
        ...sanitizeAlanaState({}),
        error: 'Alana returned an invalid live profile',
      });
    }
    return parsed;
  }

  /** Prepares one immutable television filler version in Croccante. */
  prepareFiller(
    programId: string,
    version: string,
    body: {
      source: { id: string; sha256: string; downloadUrl: string };
      profile: TelevisionLiveProfile;
    },
  ): Promise<SafeAlanaFiller | null> {
    return this.request(
      programId,
      'prepare',
      `/v1/programs/${encodeURIComponent(programId)}/fillers/${encodeURIComponent(version)}`,
      {
        method: 'PUT',
        headers: { 'Idempotency-Key': version },
        body: JSON.stringify({ commandId: version, ...body }),
      },
      sanitizeAlanaFiller,
    );
  }

  private async request(
    programId: string,
    operation: string,
    path: string,
    init: RequestInit,
  ): Promise<SafeAlanaState>;
  private async request<T>(
    programId: string,
    operation: string,
    path: string,
    init: RequestInit,
    parse: (payload: unknown) => T,
  ): Promise<T>;
  private async request<T>(
    _programId: string,
    operation: string,
    path: string,
    init: RequestInit,
    parse?: (payload: unknown) => T,
  ): Promise<T | SafeAlanaState> {
    const started = process.hrtime.bigint();
    let result = 'failure';
    let state: T | SafeAlanaState | null = null;
    let failure: AlanaRequestError | null = null;
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
      const responseState = sanitizeAlanaState(payload);
      if (!response.ok) {
        result = 'http-error';
        throw new AlanaRequestError(response.status, responseState);
      }
      result = 'success';
      state = parse ? parse(payload) : responseState;
    } catch (error) {
      if (error instanceof AlanaRequestError) {
        failure = error;
      } else {
        result = 'unavailable';
        failure = new AlanaRequestError(503, {
          ...sanitizeAlanaState({}),
          error: 'Alana is unavailable',
        });
      }
    }
    this.metrics.recordDependency(
      'alana',
      operation,
      result,
      Number(process.hrtime.bigint() - started) / 1_000_000_000,
    );
    if (failure) throw failure;
    return state as T | SafeAlanaState;
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
