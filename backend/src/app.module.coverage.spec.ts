jest.mock('music-metadata', () => ({ parseBuffer: jest.fn() }), {
  virtual: true,
});

import { ConfigModule } from '@nestjs/config';
import { AppModule } from './app.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { MetricsController } from './metrics.controller';
import { AuthModule } from './auth/auth.module';
import { ObservabilityModule } from './observability/observability.module';
import { OperatorPreferencesModule } from './operator-preferences/operator-preferences.module';
import { DatabaseBackupModule } from './database-backup/database-backup.module';

describe('AppModule metadata', () => {
  it('declares the root controllers and providers', () => {
    expect(Reflect.getMetadata('controllers', AppModule)).toEqual([
      AppController,
      MetricsController,
    ]);
    expect(Reflect.getMetadata('providers', AppModule)).toEqual([AppService]);
  });

  it('imports the platform modules and a global ConfigModule', async () => {
    const imports = (await Promise.all(
      Reflect.getMetadata('imports', AppModule) as unknown[],
    )) as unknown[];
    expect(imports).toEqual(
      expect.arrayContaining([
        ObservabilityModule,
        AuthModule,
        OperatorPreferencesModule,
        DatabaseBackupModule,
      ]),
    );
    const config = imports.find(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { module?: unknown }).module === ConfigModule,
    ) as { global?: boolean };
    expect(config.global).toBe(true);
  });
});
