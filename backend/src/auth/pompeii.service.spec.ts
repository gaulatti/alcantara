import { ConfigService } from '@nestjs/config';
import {
  PRODUCTION_POMPEII_GRPC_URL,
  PompeiiService,
  resolvePompeiiGrpcUrl,
} from './pompeii.service';

describe('PompeiiService production contract', () => {
  it('uses the code-owned production endpoint regardless of an override', () => {
    expect(resolvePompeiiGrpcUrl('production', 'untrusted:50087')).toBe(
      PRODUCTION_POMPEII_GRPC_URL,
    );
    expect(PRODUCTION_POMPEII_GRPC_URL).toBe(
      'api.pompeii.gaulatti.com:443',
    );
  });

  it('requires an explicit non-production endpoint', () => {
    expect(resolvePompeiiGrpcUrl('development', 'localhost:50087')).toBe(
      'localhost:50087',
    );
    expect(() => resolvePompeiiGrpcUrl('development', undefined)).toThrow(
      'POMPEII_GRPC_URL is required outside production',
    );
  });

  it('requires an explicit positive team in production', () => {
    const config = new ConfigService({
      NODE_ENV: 'production',
      POMPEII_TEAM_ID: '0',
      POMPEII_GRPC_URL: 'untrusted:50087',
    });

    expect(() => new PompeiiService(config)).toThrow(
      'POMPEII_TEAM_ID must be an explicit positive integer in production',
    );
  });

  it('fails production startup when Pompeii is unavailable', async () => {
    const service = new PompeiiService(
      new ConfigService({
        NODE_ENV: 'production',
        POMPEII_TEAM_ID: '42',
      }),
    );
    jest.spyOn(service, 'checkConnection').mockResolvedValue({
      target: PRODUCTION_POMPEII_GRPC_URL,
      ready: false,
      error: 'unavailable',
    });

    try {
      await expect(service.onModuleInit()).rejects.toThrow(
        'Pompeii authorization is required in production',
      );
    } finally {
      service.onModuleDestroy();
    }
  });
});
