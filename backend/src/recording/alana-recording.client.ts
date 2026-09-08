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
import {
  normalizeRecordingStatus,
  type RecordingStatus,
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
