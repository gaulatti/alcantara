import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
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
  waitForClientReady,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { join } from 'node:path';
import type { AlcantaraPermission } from './permissions';

type AuthorizeWireResponse = {
  authenticated?: boolean;
  allowed?: boolean;
  reason?: string;
  subject?: string;
  effective_permissions?: string[];
  roles?: string[];
};

export type AuthorizationDecision = {
  authenticated: boolean;
  allowed: boolean;
  reason: string;
  subject: string;
  effectivePermissions: string[];
  roles: string[];
};

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
) => AuthorizationClient;

export const PRODUCTION_POMPEII_GRPC_URL = 'api.pompeii.gaulatti.com:443';
export const LOCAL_POMPEII_GRPC_URL = 'host.docker.internal:50087';

export function resolvePompeiiGrpcUrl(
  nodeEnv: string | undefined,
): string {
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
  private readonly client: AuthorizationClient;
  private readonly isProduction: boolean;
  readonly teamId: number;

  constructor(config: ConfigService) {
    this.isProduction = config.get<string>('NODE_ENV') === 'production';
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
    this.client = new loaded.pompeii.authorization.v1.AuthorizationService(
      this.grpcUrl,
      this.isProduction ? credentials.createSsl() : credentials.createInsecure(),
    );
  }

  async onModuleInit(): Promise<void> {
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
    this.client.close();
  }

  async checkConnection(
    timeoutMs = this.timeoutMs,
  ): Promise<{ target: string; ready: boolean; error?: string }> {
    try {
      await new Promise<void>((resolve, reject) => {
        waitForClientReady(
          this.client,
          new Date(Date.now() + timeoutMs),
          (error) => (error ? reject(error) : resolve()),
        );
      });
      return { target: this.grpcUrl, ready: true };
    } catch (error) {
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
    try {
      const response = await new Promise<AuthorizeWireResponse>(
        (resolve, reject) => {
          this.client.authorize(
            {
              bearer_token: bearerToken,
              permission,
              team_id: this.teamId,
            },
            { deadline: new Date(Date.now() + this.timeoutMs) },
            (error, value) => {
              if (error) reject(error);
              else resolve(value ?? {});
            },
          );
        },
      );
      return {
        authenticated: response.authenticated === true,
        allowed: response.allowed === true,
        reason: response.reason || 'DENY_UNSPECIFIED',
        subject: response.subject || '',
        effectivePermissions: response.effective_permissions ?? [],
        roles: response.roles ?? [],
      };
    } catch (error) {
      this.logger.error(
        `Pompeii decision failed for ${permission}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException({
        error: 'AUTHORIZATION_SERVICE_UNAVAILABLE',
      });
    }
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
