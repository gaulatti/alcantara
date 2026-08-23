import { ConfigService } from '@nestjs/config';
import {
  LOCAL_POMPEII_GRPC_URL,
  PRODUCTION_POMPEII_GRPC_URL,
  PompeiiService,
  resolvePompeiiGrpcUrl,
} from './pompeii.service';

describe('PompeiiService production contract', () => {
  it('uses the code-owned production endpoint regardless of an override', () => {
    expect(resolvePompeiiGrpcUrl('production')).toBe(
      PRODUCTION_POMPEII_GRPC_URL,
    );
    expect(PRODUCTION_POMPEII_GRPC_URL).toBe(
      'api.pompeii.gaulatti.com:443',
    );
  });

  it('uses the code-owned local endpoint outside production', () => {
    expect(resolvePompeiiGrpcUrl('development')).toBe(LOCAL_POMPEII_GRPC_URL);
    expect(LOCAL_POMPEII_GRPC_URL).toBe('host.docker.internal:50087');
  });

  it('requires an explicit positive team in production', () => {
    const config = new ConfigService({
      NODE_ENV: 'production',
      POMPEII_TEAM_ID: '0',
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
