import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChannelCredentials,
  Client,
  type ClientUnaryCall,
  type ServiceError,
  credentials,
  loadPackageDefinition,
  status,
  waitForClientReady,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { join } from 'node:path';
import type { AlcantaraPermission } from './permissions';
import { ManagedMetricsService } from '../observability/managed-metrics.service';

type AuthorizeWireResponse = {
  authenticated?: boolean;
  allowed?: boolean;
  reason?: string;
  subject?: string;
  effective_permissions?: string[];
  roles?: string[];
  principal_id?: string;
};

export type AuthorizationDecision = {
  authenticated: boolean;
  allowed: boolean;
  reason: string;
  subject: string;
  /**
   * Pompeii's canonical principal, stable for one real person across Cognito
   * pools. `null` while an identity has not been resolved to a principal yet,
   * which is the expected state during rollout. Never derived from an email.
   */
  principalId: string | null;
  effectivePermissions: string[];
  roles: string[];
};

export function mapAuthorizationDecision(
  response: AuthorizeWireResponse,
): AuthorizationDecision {
  return {
    authenticated: response.authenticated === true,
    allowed: response.allowed === true,
    reason: response.reason || 'DENY_UNSPECIFIED',
    subject: response.subject || '',
    principalId: response.principal_id?.trim() || null,
    effectivePermissions: response.effective_permissions ?? [],
    roles: response.roles ?? [],
  };
}

type AuthorizationClient = Client & {
  authorize(
    request: {
      bearer_token: string;
      permission: string;
      team_id: number;
    },
    options: { deadline: Date },
    callback: (
      error: ServiceError | null,
      response?: AuthorizeWireResponse,
    ) => void,
  ): ClientUnaryCall;
};

type AuthorizationClientConstructor = new (
  address: string,
  channelCredentials: ChannelCredentials,
  options?: Record<string, number>,
) => AuthorizationClient;

type AuthorizeWireRequest = Parameters<AuthorizationClient['authorize']>[0];

export const POMPEII_CHANNEL_RESET_REASONS = [
  'deadline_exceeded',
  'unavailable',
] as const;
export type PompeiiChannelResetReason =
  (typeof POMPEII_CHANNEL_RESET_REASONS)[number];

/** Minimum time between two channel replacements (gaulatti/alcantara#225). */
export const POMPEII_CHANNEL_RESET_INTERVAL_MS = 5_000;

/**
 * Every channel gets its own subchannel pool, so a replacement dials a new
 * connection instead of reusing the one that went dead.
 */
export const POMPEII_CHANNEL_OPTIONS = { 'grpc.use_local_subchannel_pool': 1 };

function resetReason(error: unknown): PompeiiChannelResetReason | null {
  const code = (error as Partial<ServiceError> | null)?.code;
  if (code === status.DEADLINE_EXCEEDED) return 'deadline_exceeded';
  if (code === status.UNAVAILABLE) return 'unavailable';
  return null;
}

/**
 * One gRPC channel to Pompeii that is replaced when a call times out or the
 * transport is unavailable (gaulatti/alcantara#225). A Pompeii deploy swaps
 * its container; a long-lived HTTP/2 connection through the old path can be
 * black-holed with no error, and calls on it only time out. Replacing the
 * channel dials a fresh connection to the live container. Replacements are at
 * most one per interval, so a slow Pompeii cannot cause a dial storm. A failed
 * call still fails: the caller denies.
 */
export class PompeiiChannel {
  private client: AuthorizationClient;
  private lastReset = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly dial: () => AuthorizationClient,
    private readonly onReset: (reason: PompeiiChannelResetReason) => void,
    private readonly intervalMs = POMPEII_CHANNEL_RESET_INTERVAL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.client = dial();
  }

  get current(): AuthorizationClient {
    return this.client;
  }

  authorize(
    request: AuthorizeWireRequest,
    timeoutMs: number,
  ): Promise<AuthorizeWireResponse> {
    const client = this.client;
    return new Promise<AuthorizeWireResponse>((resolve, reject) => {
      client.authorize(
        request,
        { deadline: new Date(this.now() + timeoutMs) },
        (error, value) => {
          if (error) {
            this.replaceAfter(client, error);
            reject(error);
          } else resolve(value ?? {});
        },
      );
    });
  }

  close(): void {
    this.client.close();
  }

  private replaceAfter(failed: AuthorizationClient, error: unknown): void {
    const reason = resetReason(error);
    // Only the channel that failed is replaced, once, however many of its
    // calls fail together.
    if (!reason || failed !== this.client) return;
    const now = this.now();
    if (now - this.lastReset < this.intervalMs) return;
    this.lastReset = now;
    this.client = this.dial();
    failed.close();
    this.onReset(reason);
  }
}

export const PRODUCTION_POMPEII_GRPC_URL = 'api.pompeii.gaulatti.com:443';
export const LOCAL_POMPEII_GRPC_URL = 'host.docker.internal:50087';

export function resolvePompeiiGrpcUrl(nodeEnv: string | undefined): string {
  if (nodeEnv === 'production') {
    return PRODUCTION_POMPEII_GRPC_URL;
  }
  return LOCAL_POMPEII_GRPC_URL;
}

@Injectable()
export class PompeiiService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PompeiiService.name);
  private readonly grpcUrl: string;
  private readonly timeoutMs: number;
  private readonly channel: PompeiiChannel;
  private readonly isProduction: boolean;
  private readonly isTestAuth: boolean;
  readonly teamId: number;

  constructor(
    config: ConfigService,
    @Optional() private readonly metrics?: ManagedMetricsService,
  ) {
    this.isProduction = config.get<string>('NODE_ENV') === 'production';
    this.isTestAuth = config.get<string>('AUTH_MODE') === 'test';
    this.grpcUrl = resolvePompeiiGrpcUrl(config.get<string>('NODE_ENV'));
    this.timeoutMs = this.positiveInteger(
      config.get<string>('POMPEII_GRPC_TIMEOUT_MS'),
      2_000,
    );
    this.teamId = this.nonNegativeInteger(
      config.get<string>('POMPEII_TEAM_ID'),
      0,
    );
    if (this.isProduction && this.teamId === 0) {
      throw new Error(
        'POMPEII_TEAM_ID must be an explicit positive integer in production',
      );
    }

    const protoPath = join(__dirname, '..', 'proto', 'authorization.proto');
    const definition = loadSync(protoPath, {
      defaults: true,
      enums: String,
      keepCase: true,
      longs: String,
      oneofs: true,
    });
    const loaded = loadPackageDefinition(definition) as unknown as {
      pompeii: {
        authorization: {
          v1: { AuthorizationService: AuthorizationClientConstructor };
        };
      };
    };
    const Client = loaded.pompeii.authorization.v1.AuthorizationService;
    const channelCredentials = this.isProduction
      ? credentials.createSsl()
      : credentials.createInsecure();
    this.channel = new PompeiiChannel(
      () =>
        new Client(this.grpcUrl, channelCredentials, POMPEII_CHANNEL_OPTIONS),
      (reason) => {
        this.metrics?.recordPompeiiChannelReset(reason);
        this.logger.warn(
          `Pompeii channel replaced after ${reason} (${this.grpcUrl})`,
        );
      },
    );
  }

  async onModuleInit(): Promise<void> {
    if (this.isTestAuth) {
      this.logger.log(
        'Pompeii network authorization replaced by local test-token verification',
      );
      return;
    }
    const status = await this.checkConnection(this.timeoutMs);
    if (status.ready) {
      this.logger.log(
        `Pompeii authorization ready at ${status.target} (team ${this.teamId || 'global'})`,
      );
      return;
    }
    this.logger.warn(
      `Pompeii authorization unavailable at startup (${status.target}): ${status.error}`,
    );
    if (this.isProduction) {
      throw new Error(
        `Pompeii authorization is required in production: ${status.error ?? 'unavailable'}`,
      );
    }
  }

  onModuleDestroy(): void {
    this.channel.close();
  }

  async checkConnection(
    timeoutMs = this.timeoutMs,
  ): Promise<{ target: string; ready: boolean; error?: string }> {
    const started = process.hrtime.bigint();
    try {
      await new Promise<void>((resolve, reject) => {
        waitForClientReady(
          this.channel.current,
          new Date(Date.now() + timeoutMs),
          (error) => (error ? reject(error) : resolve()),
        );
      });
      this.recordMetric('connect', 'success', started);
      return { target: this.grpcUrl, ready: true };
    } catch (error) {
      this.recordMetric('connect', 'unavailable', started);
      return {
        target: this.grpcUrl,
        ready: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async authorize(
    bearerToken: string,
    permission: AlcantaraPermission,
  ): Promise<AuthorizationDecision> {
    const started = process.hrtime.bigint();
    try {
      const response = await this.channel.authorize(
        { bearer_token: bearerToken, permission, team_id: this.teamId },
        this.timeoutMs,
      );
      const decision = mapAuthorizationDecision(response);
      this.recordMetric(
        'authorize',
        decision.authenticated && decision.allowed ? 'success' : 'denied',
        started,
      );
      return decision;
    } catch (error) {
      this.recordMetric('authorize', 'unavailable', started);
      this.logger.error(
        `Pompeii decision failed for ${permission}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException({
        error: 'AUTHORIZATION_SERVICE_UNAVAILABLE',
      });
    }
  }

  /** Counts a request the guard refused before any authorization call. */
  recordUnsupportedCredential(): void {
    this.metrics?.recordAuthRefusal('unsupported_credential');
  }

  private recordMetric(
    operation: 'authorize' | 'connect',
    result: 'success' | 'denied' | 'unavailable',
    started: bigint,
  ): void {
    this.metrics?.recordDependency(
      'pompeii',
      operation,
      result,
      Number(process.hrtime.bigint() - started) / 1_000_000_000,
    );
  }

  private positiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private nonNegativeInteger(
    value: string | undefined,
    fallback: number,
  ): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
  }
}
