import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface EnrichedUser {
  sub: string;
  email: string;
  name: string;
  username: string;
  context: {
    features: Record<string, { level: string }>;
    permissions: string[];
    roles: string[];
    teams: string[];
  };
}

@Injectable()
export class PompeiiService implements OnModuleInit {
  private readonly logger = new Logger(PompeiiService.name);
  private readonly grpcUrl: string;

  constructor(configService: ConfigService) {
    const grpcHost =
      configService.get<string>('POMPEII_GRPC_HOST') || 'localhost';
    const grpcPort = configService.get<string>('POMPEII_GRPC_PORT') || '50051';
    this.grpcUrl =
      configService.get<string>('POMPEII_GRPC_URL') ||
      `${grpcHost}:${grpcPort}`;

    // Pompeii/gRPC integration is temporarily disabled.
    // Keeping config resolution so logs/context remain useful.
    this.logger.log(
      `Pompeii integration disabled (target would be ${this.grpcUrl})`,
    );
  }

  async onModuleInit() {
    // Integration intentionally disabled.
    this.logger.log('Pompeii integration disabled at module init');
  }

  async checkConnection(
    _timeoutMs = 3_000,
  ): Promise<{ target: string; ready: boolean; error?: string }> {
    // Connection checks are disabled with the integration.
    return {
      target: this.grpcUrl,
      ready: false,
      error: 'pompeii_integration_disabled',
    };
  }

  async authenticate(rawToken: string): Promise<EnrichedUser | null> {
    // Authentication enrichment via Pompeii is disabled.
    // Returning null preserves "no external enrichment" behavior.
    void rawToken;
    this.logger.warn('Pompeii authenticate skipped: integration disabled');
    return null;
  }
}
