import {
  BadGatewayException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { Readable } from 'node:stream';
import {
  normalizeRecordingStatus,
  normalizeTapeStatus,
  type RecordingStatus,
  type TapeStatus,
} from './recording.contract';
import {
  isValidAlanaControlToken,
  normalizeAlanaControlUrl,
} from '../config/runtime-secret-contract';

export const ALANA_RECORDING_FETCH = Symbol('ALANA_RECORDING_FETCH');

export type RecordingFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;
type RecordingAction = 'start' | 'stop';
const TAPE_START_TIMEOUT_MS = 120_000;
const TAPE_STOP_TIMEOUT_MS = 150_000;

@Injectable()
export class AlanaRecordingClient {
  private readonly logger = new Logger(AlanaRecordingClient.name);
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly transport: RecordingFetch;

  constructor(
    config: ConfigService,
    private readonly metrics: ManagedMetricsService,
    @Optional()
    @Inject(ALANA_RECORDING_FETCH)
    transport?: RecordingFetch,
  ) {
    const isTest = config.get<string>('NODE_ENV') === 'test';
    this.baseUrl = normalizeAlanaControlUrl(
      config.get<string>('ALANA_CONTROL_URL') ??
        (isTest ? 'http://alana:8080' : ''),
    );
    this.token =
      config.get<string>('ALANA_CONTROL_TOKEN') ??
      (isTest
        ? '0000000000000000000000000000000000000000000000000000000000000000'
        : '');
    if (!isValidAlanaControlToken(this.token)) {
      throw new Error('ALANA_CONTROL_TOKEN is missing or invalid');
    }
    this.timeoutMs = 5_000;
    this.transport =
      transport ?? ((input, init) => globalThis.fetch(input, init));
  }

  async status(programId: string): Promise<RecordingStatus> {
    return this.request(programId, 'status');
  }

  async command(
    programId: string,
    action: RecordingAction,
    idempotencyKey: string,
  ): Promise<RecordingStatus> {
    return this.request(programId, action, idempotencyKey);
  }

  async tapeStatus(programId: string): Promise<TapeStatus> {
    return this.tapeRequest(programId, 'status');
  }

  async tapeCommand(
    programId: string,
    action: RecordingAction,
    idempotencyKey: string,
  ): Promise<TapeStatus> {
    return this.tapeRequest(programId, action, idempotencyKey);
  }

  /**
   * Opens the finalized program MP4. The body is a live stream: the caller owns
   * it and must call `abort` when the client goes away.
   */
  async openRecordingFile(
    programId: string,
    range?: string,
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: Readable | null;
    abort: () => void;
  }> {
    const started = process.hrtime.bigint();
    const controller = new AbortController();
    // Bound only the wait for response headers; the body may take as long as
    // a multi-gigabyte download needs.
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.transport(
        `${this.baseUrl}/v1/programs/${encodeURIComponent(programId)}/recording/file`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.token}`,
            ...(range ? { Range: range } : {}),
          },
          signal: controller.signal,
        },
      );
    } catch {
      this.recordDependency('read', 'unavailable', started);
      throw new ServiceUnavailableException({
        error: 'ALANA_RECORDING_UNAVAILABLE',
      });
    } finally {
      clearTimeout(timer);
    }
    this.recordDependency(
      'read',
      response.ok || response.status === 416 ? 'success' : 'http-error',
      started,
    );
    const headers: Record<string, string> = {};
    for (const name of [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'content-disposition',
    ]) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    const body =
      response.body && (response.ok || response.status === 416)
        ? Readable.fromWeb(response.body as never)
        : null;
    if (!body) void response.body?.cancel().catch(() => undefined);
    return {
      status: response.status,
      headers,
      body,
      abort: () => controller.abort(),
    };
  }

  private async tapeRequest(
    programId: string,
    operation: 'status' | RecordingAction,
    idempotencyKey?: string,
  ): Promise<TapeStatus> {
    const started = process.hrtime.bigint();
    const isStatus = operation === 'status';
    // Start waits for the private pipeline and Stop waits for finalization in
    // Alana, so command timeouts must exceed those bounded server-side waits.
    const timeoutMs = isStatus
      ? this.timeoutMs
      : operation === 'start'
        ? TAPE_START_TIMEOUT_MS
        : TAPE_STOP_TIMEOUT_MS;
    let response: Response;
    try {
      response = await this.transport(
        `${this.baseUrl}/v1/programs/${encodeURIComponent(programId)}/tape${isStatus ? '' : `/${operation}`}`,
        {
          method: isStatus ? 'GET' : 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          },
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch {
      this.recordDependency(
        isStatus ? 'read' : 'write',
        'unavailable',
        started,
      );
      if (!isStatus) this.recordTapeAudit(operation, 'unavailable', 503);
      throw new ServiceUnavailableException({
        error: 'ALANA_TAPE_UNAVAILABLE',
      });
    }

    let status: TapeStatus;
    try {
      status = normalizeTapeStatus(await response.json());
    } catch {
      this.recordDependency(
        isStatus ? 'read' : 'write',
        'invalid-response',
        started,
      );
      if (!isStatus) this.recordTapeAudit(operation, 'invalid-response', 502);
      throw new BadGatewayException({ error: 'ALANA_TAPE_INVALID_RESPONSE' });
    }

    this.recordDependency(
      isStatus ? 'read' : 'write',
      response.ok ? 'success' : 'http-error',
      started,
    );
    const reason = status.commandResult?.result ?? 'success';
    if (!isStatus) this.recordTapeAudit(operation, reason, response.status);
    if (!response.ok) {
      throw new HttpException(
        { error: 'TAPE_COMMAND_REJECTED', reason, tape: status },
        response.status >= 400 && response.status <= 599
          ? response.status
          : 502,
      );
    }
    return status;
  }

  private recordTapeAudit(
    action: RecordingAction,
    result: string,
    status: number,
  ): void {
    this.logger.log(
      JSON.stringify({ event: 'tape-command', action, result, status }),
    );
  }

  private async request(
    programId: string,
    operation: 'status' | RecordingAction,
    idempotencyKey?: string,
  ): Promise<RecordingStatus> {
    const started = process.hrtime.bigint();
    const isStatus = operation === 'status';
    const url = `${this.baseUrl}/v1/programs/${encodeURIComponent(programId)}/recording${isStatus ? '' : `/${operation}`}`;
    let response: Response;
    try {
      response = await this.transport(url, {
        method: isStatus ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      this.recordDependency(
        isStatus ? 'read' : 'write',
        'unavailable',
        started,
      );
      if (!isStatus) this.recordAudit(operation, 'unavailable', 503);
      throw new ServiceUnavailableException({
        error: 'ALANA_RECORDING_UNAVAILABLE',
      });
    }

    let status: RecordingStatus;
    try {
      status = normalizeRecordingStatus(await response.json());
    } catch {
      this.recordDependency(
        isStatus ? 'read' : 'write',
        'invalid-response',
        started,
      );
      if (!isStatus) this.recordAudit(operation, 'invalid-response', 502);
      throw new BadGatewayException({
        error: 'ALANA_RECORDING_INVALID_RESPONSE',
      });
    }

    const result = response.ok ? 'success' : 'http-error';
    this.recordDependency(isStatus ? 'read' : 'write', result, started);
    this.metrics.recordRecordingStatus(
      status.state,
      response.ok ? 'success' : 'failure',
    );

    if (!response.ok) {
      const boundedReason =
        status.commandResult?.result ?? status.error ?? 'unknown';
      if (!isStatus) {
        this.metrics.recordRecordingCommand(operation, boundedReason);
        this.recordAudit(operation, boundedReason, response.status);
      }
      throw new HttpException(
        {
          error: 'RECORDING_COMMAND_REJECTED',
          reason: boundedReason,
          recording: status,
        },
        response.status >= 400 && response.status <= 599
          ? response.status
          : 502,
      );
    }

    if (!isStatus) {
      const boundedResult = status.commandResult?.result ?? 'success';
      this.metrics.recordRecordingCommand(operation, boundedResult);
      this.recordAudit(operation, boundedResult, response.status);
    }
    return status;
  }

  private recordDependency(
    operation: 'read' | 'write',
    result: string,
    started: bigint,
  ): void {
    this.metrics.recordDependency(
      'alana',
      operation,
      result,
      Number(process.hrtime.bigint() - started) / 1_000_000_000,
    );
  }

  private recordAudit(
    action: RecordingAction,
    result: string,
    status: number,
  ): void {
    this.logger.log(
      JSON.stringify({
        event: 'recording-command',
        action,
        result,
        status,
      }),
    );
  }
}
