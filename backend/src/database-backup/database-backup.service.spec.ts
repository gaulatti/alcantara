import { ConfigService } from '@nestjs/config';
import { existsSync, writeFileSync } from 'node:fs';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  DatabaseBackupStorage,
  DatabaseDumpRunner,
} from './database-backup.contracts';
import {
  DATABASE_BACKUP_PREFIX,
  DatabaseBackupService,
  millisecondsUntilNextUtcHour,
} from './database-backup.service';

function productionConfig(
  overrides: Record<string, string | undefined> = {},
): ConfigService {
  const values: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://backup-user:secret@db.internal/alcantara',
    MEDIA_S3_BUCKET: 'media-bucket',
    AWS_REGION: 'us-east-1',
    ...overrides,
  };
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe('DatabaseBackupService', () => {
  it('calculates the next top-of-hour boundary in UTC', () => {
    expect(
      millisecondsUntilNextUtcHour(new Date('2026-09-14T10:15:30.250Z')),
    ).toBe(2_669_750);
    expect(
      millisecondsUntilNextUtcHour(new Date('2026-09-14T10:00:00.000Z')),
    ).toBe(3_600_000);
  });

  it('does not enable or run backups outside production', async () => {
    const dump = jest.fn();
    const upload = jest.fn();
    const service = new DatabaseBackupService(
      productionConfig({ NODE_ENV: 'development', DATABASE_URL: undefined }),
      new ManagedMetricsService(),
      { dump },
      { upload },
    );

    expect(() => service.onModuleInit()).not.toThrow();
    await expect(service.runBackup()).resolves.toBe('skipped');
    expect(dump).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('fails production startup when required configuration is missing', () => {
    const service = new DatabaseBackupService(
      productionConfig({ MEDIA_S3_BUCKET: undefined }),
      new ManagedMetricsService(),
      { dump: jest.fn() },
      { upload: jest.fn() },
    );

    expect(() => service.onModuleInit()).toThrow(
      'Production database backup configuration is incomplete',
    );
  });

  it('dumps, uploads, records success, and removes temporary files', async () => {
    let temporaryDirectory = '';
    const dumpRunner: DatabaseDumpRunner = {
      dump: jest.fn((_databaseUrl, outputPath, workingDirectory) => {
        temporaryDirectory = workingDirectory;
        writeFileSync(outputPath, 'compressed backup');
        return Promise.resolve();
      }),
    };
    let uploadedKey = '';
    const storage: DatabaseBackupStorage = {
      upload: jest.fn(({ bucket, key, filePath }) => {
        expect(bucket).toBe('media-bucket');
        expect(existsSync(filePath)).toBe(true);
        uploadedKey = key;
        return Promise.resolve();
      }),
    };
    const metrics = new ManagedMetricsService();
    const service = new DatabaseBackupService(
      productionConfig(),
      metrics,
      dumpRunner,
      storage,
    );

    await expect(service.runBackup()).resolves.toBe('success');
    expect(uploadedKey).toMatch(
      new RegExp(`^${DATABASE_BACKUP_PREFIX}/alcantara-.*\\.sql\\.gz$`),
    );
    expect(existsSync(temporaryDirectory)).toBe(false);
    const output = await metrics.render('');
    expect(output).toContain(
      'alcantara_jobs_total{job="database-backup",result="success"} 1',
    );
    expect(output).toContain(
      'alcantara_job_last_success_timestamp_seconds{job="database-backup"}',
    );
    expect(output).toContain(
      'alcantara_dependency_operations_total{dependency="postgres",operation="read",result="success"} 1',
    );
    expect(output).toContain(
      'alcantara_dependency_operations_total{dependency="s3",operation="write",result="success"} 1',
    );
  });

  it('records a failed dump and still removes its temporary directory', async () => {
    let temporaryDirectory = '';
    const dumpRunner: DatabaseDumpRunner = {
      dump: jest.fn((_databaseUrl, _outputPath, workingDirectory) => {
        temporaryDirectory = workingDirectory;
        return Promise.reject(new Error('sensitive database detail'));
      }),
    };
    const upload = jest.fn();
    const storage: DatabaseBackupStorage = { upload };
    const metrics = new ManagedMetricsService();
    const service = new DatabaseBackupService(
      productionConfig(),
      metrics,
      dumpRunner,
      storage,
    );

    await expect(service.runBackup()).resolves.toBe('failure');
    expect(upload).not.toHaveBeenCalled();
    expect(existsSync(temporaryDirectory)).toBe(false);
    const output = await metrics.render('');
    expect(output).toContain(
      'alcantara_jobs_total{job="database-backup",result="failure"} 1',
    );
    expect(output).toContain(
      'alcantara_dependency_operations_total{dependency="postgres",operation="read",result="failure"} 1',
    );
    expect(output).not.toContain('sensitive database detail');
  });

  it('skips an overlapping run and records the bounded result', async () => {
    let releaseDump: (() => void) | undefined;
    let notifyStarted: (() => void) | undefined;
    const dumpStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const dumpRunner: DatabaseDumpRunner = {
      dump: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseDump = resolve;
            notifyStarted?.();
          }),
      ),
    };
    const storage: DatabaseBackupStorage = { upload: jest.fn() };
    const metrics = new ManagedMetricsService();
    const service = new DatabaseBackupService(
      productionConfig(),
      metrics,
      dumpRunner,
      storage,
    );

    const activeRun = service.runBackup();
    await dumpStarted;
    await expect(service.runBackup()).resolves.toBe('skipped');
    expect(releaseDump).toBeDefined();
    releaseDump!();
    await activeRun;

    const output = await metrics.render('');
    expect(output).toContain(
      'alcantara_jobs_total{job="database-backup",result="skipped"} 1',
    );
  });
});
