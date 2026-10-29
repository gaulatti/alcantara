import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { S3Client } from '@aws-sdk/client-s3';
import { ObservabilityModule } from '../observability/observability.module';
import {
  DATABASE_BACKUP_STORAGE,
  DATABASE_DUMP_RUNNER,
} from './database-backup.contracts';
import { DatabaseBackupModule } from './database-backup.module';
import { PgDumpRunner } from './pg-dump.runner';
import { S3DatabaseBackupStorage } from './s3-database-backup.storage';

async function compile(values: Record<string, string>) {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        isGlobal: true,
        load: [() => ({ NODE_ENV: 'test', ...values })],
      }),
      ObservabilityModule,
      DatabaseBackupModule,
    ],
  }).compile();
}

async function regionOf(values: Record<string, string>) {
  const original = { ...process.env };
  delete process.env.AWS_REGION;
  delete process.env.AWS_DEFAULT_REGION;
  try {
    const moduleRef = await compile(values);
    const storage = moduleRef.get<S3DatabaseBackupStorage>(
      DATABASE_BACKUP_STORAGE,
    );
    const client = (storage as unknown as { client: S3Client }).client;
    const region = await client.config.region();
    client.destroy();
    await moduleRef.close();
    return region;
  } finally {
    process.env = original;
  }
}

describe('DatabaseBackupModule providers', () => {
  it('provides a pg_dump runner and an S3 storage', async () => {
    const moduleRef = await compile({ AWS_REGION: 'us-east-1' });
    expect(moduleRef.get(DATABASE_DUMP_RUNNER)).toBeInstanceOf(PgDumpRunner);
    const storage = moduleRef.get(DATABASE_BACKUP_STORAGE);
    expect(storage).toBeInstanceOf(S3DatabaseBackupStorage);
    (storage as unknown as { client: S3Client }).client.destroy();
    await moduleRef.close();
  });

  it('prefers AWS_REGION for the S3 client', async () => {
    await expect(
      regionOf({ AWS_REGION: 'us-west-2', AWS_DEFAULT_REGION: 'eu-west-1' }),
    ).resolves.toBe('us-west-2');
  });

  it('falls back to AWS_DEFAULT_REGION', async () => {
    await expect(regionOf({ AWS_DEFAULT_REGION: 'eu-west-1' })).resolves.toBe(
      'eu-west-1',
    );
  });
});
