import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ObservabilityModule } from '../observability/observability.module';
import { DatabaseBackupModule } from './database-backup.module';
import { DatabaseBackupService } from './database-backup.service';

describe('DatabaseBackupModule', () => {
  it('constructs and initializes without AWS or PostgreSQL in non-production', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          isGlobal: true,
          load: [() => ({ NODE_ENV: 'test' })],
        }),
        ObservabilityModule,
        DatabaseBackupModule,
      ],
    }).compile();

    await moduleRef.init();
    expect(moduleRef.get(DatabaseBackupService)).toBeInstanceOf(
      DatabaseBackupService,
    );
    await moduleRef.close();
  });
});
