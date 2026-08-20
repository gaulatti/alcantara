import { ConfigService } from '@nestjs/config';
import { PompeiiService } from './pompeii.service';

describe('PompeiiService production contract', () => {
  it('requires an explicit positive team in production', () => {
    const config = new ConfigService({
      NODE_ENV: 'production',
      POMPEII_TEAM_ID: '0',
      POMPEII_GRPC_URL: 'localhost:50087',
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
        POMPEII_GRPC_URL: '127.0.0.1:1',
        POMPEII_GRPC_TIMEOUT_MS: '25',
      }),
    );

    try {
      await expect(service.onModuleInit()).rejects.toThrow(
        'Pompeii authorization is required in production',
      );
    } finally {
      service.onModuleDestroy();
    }
  });
});
