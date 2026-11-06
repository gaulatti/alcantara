import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { mkdtemp, rm } from 'node:fs/promises';
import type { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  DATABASE_BACKUP_PREFIX,
  DatabaseBackupService,
} from './database-backup.service';

jest.mock('node:fs/promises', () => ({
  mkdtemp: jest.fn(),
  rm: jest.fn(),
}));
const mkdtempMock = jest.mocked(mkdtemp);
const rmMock = jest.mocked(rm);

function config(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    DATABASE_URL: ' postgresql://u:p@db.internal/alcantara ',
    MEDIA_S3_BUCKET: ' bucket ',
    AWS_REGION: 'us-east-1',
    ...overrides,
  };
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function build(
  overrides: Record<string, string | undefined> = {},
  deps: { dump?: jest.Mock; upload?: jest.Mock } = {},
) {
  const metrics = {
    recordJob: jest.fn(),
    recordDependency: jest.fn(),
  };
  const dump = deps.dump ?? jest.fn().mockResolvedValue(undefined);
  const upload = deps.upload ?? jest.fn().mockResolvedValue(undefined);
  const service = new DatabaseBackupService(
    config(overrides),
    metrics as unknown as ManagedMetricsService,
    { dump },
    { upload },
  );
  return { service, metrics, dump, upload };
}

describe('DatabaseBackupService coverage', () => {
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mkdtempMock.mockResolvedValue('/tmp/alcantara-db-backup-x');
    rmMock.mockResolvedValue(undefined);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('runBackup success path', () => {
    it('dumps, uploads under the prefix, cleans up, and records success', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-03-04T05:06:07.000Z'));
      const { service, metrics, dump, upload } = build();

      await expect(service.runBackup()).resolves.toBe('success');

      const filename = 'alcantara-2026-03-04T05-06-07.000Z.sql.gz';
      const filePath = `/tmp/alcantara-db-backup-x/${filename}`;
      expect(dump).toHaveBeenCalledWith(
        'postgresql://u:p@db.internal/alcantara',
        filePath,
        '/tmp/alcantara-db-backup-x',
      );
      expect(upload).toHaveBeenCalledWith({
        bucket: 'bucket',
        key: `${DATABASE_BACKUP_PREFIX}/${filename}`,
        filePath,
      });
      expect(rmMock).toHaveBeenCalledWith('/tmp/alcantara-db-backup-x', {
        recursive: true,
        force: true,
      });
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        'postgres',
        'read',
        'success',
        expect.any(Number),
      );
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        's3',
        'write',
        'success',
        expect.any(Number),
      );
      expect(metrics.recordJob).toHaveBeenCalledWith(
        'database-backup',
        'success',
      );
      expect(log).toHaveBeenCalledWith('Hourly PostgreSQL backup completed');
    });

    it('accepts AWS_DEFAULT_REGION when AWS_REGION is absent', async () => {
      const { service } = build({
        AWS_REGION: undefined,
        AWS_DEFAULT_REGION: 'eu-west-1',
      });
      await expect(service.runBackup()).resolves.toBe('success');
    });
  });

  describe('runBackup failure paths', () => {
    it('fails without leaking details when the dump fails, and still cleans up', async () => {
      const { service, metrics, upload } = build(
        {},
        {
          dump: jest
            .fn()
            .mockRejectedValue(new Error('pg_dump password=secret')),
        },
      );
      await expect(service.runBackup()).resolves.toBe('failure');
      expect(upload).not.toHaveBeenCalled();
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        'postgres',
        'read',
        'failure',
        expect.any(Number),
      );
      expect(metrics.recordJob).toHaveBeenCalledWith(
        'database-backup',
        'failure',
      );
      expect(error).toHaveBeenCalledWith(
        'Hourly PostgreSQL backup failed during dump',
      );
      expect(rmMock).toHaveBeenCalledTimes(1);
    });

    it('fails when the upload fails', async () => {
      const { service, metrics } = build(
        {},
        { upload: jest.fn().mockRejectedValue(new Error('denied')) },
      );
      await expect(service.runBackup()).resolves.toBe('failure');
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        's3',
        'write',
        'failure',
        expect.any(Number),
      );
      expect(error).toHaveBeenCalledWith(
        'Hourly PostgreSQL backup failed during upload',
      );
    });

    it('fails during cleanup when the work directory cannot be removed', async () => {
      rmMock.mockRejectedValueOnce(new Error('EBUSY'));
      const { service, metrics } = build();
      await expect(service.runBackup()).resolves.toBe('failure');
      expect(metrics.recordJob).toHaveBeenCalledWith(
        'database-backup',
        'failure',
      );
      expect(metrics.recordJob).not.toHaveBeenCalledWith(
        'database-backup',
        'success',
      );
      expect(error).toHaveBeenCalledWith(
        'Hourly PostgreSQL backup failed during cleanup',
      );
    });

    it('fails during prepare without cleaning up when the work directory cannot be created', async () => {
      mkdtempMock.mockRejectedValueOnce(new Error('ENOSPC'));
      const { service, dump } = build();
      await expect(service.runBackup()).resolves.toBe('failure');
      expect(dump).not.toHaveBeenCalled();
      expect(rmMock).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        'Hourly PostgreSQL backup failed during prepare',
      );
    });

    it.each([
      ['DATABASE_URL', { DATABASE_URL: ' ' }],
      ['MEDIA_S3_BUCKET', { MEDIA_S3_BUCKET: undefined }],
      ['region', { AWS_REGION: undefined, AWS_DEFAULT_REGION: undefined }],
      ['blank region', { AWS_REGION: '  ' }],
    ])('fails during prepare when %s is missing', async (_name, overrides) => {
      const { service, metrics } = build(overrides);
      await expect(service.runBackup()).resolves.toBe('failure');
      expect(mkdtempMock).not.toHaveBeenCalled();
      expect(metrics.recordJob).toHaveBeenCalledWith(
        'database-backup',
        'failure',
      );
      expect(error).toHaveBeenCalledWith(
        'Hourly PostgreSQL backup failed during prepare',
      );
    });
  });

  describe('overlap and environment', () => {
    it('skips and records a skip while another backup is running', async () => {
      let release: () => void = () => undefined;
      const dump = jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        )
        .mockResolvedValue(undefined);
      const { service, metrics } = build({}, { dump });
      const first = service.runBackup();
      await new Promise((resolve) => setImmediate(resolve));

      await expect(service.runBackup()).resolves.toBe('skipped');
      expect(metrics.recordJob).toHaveBeenCalledWith(
        'database-backup',
        'skipped',
      );
      expect(warn).toHaveBeenCalledWith(
        'Hourly PostgreSQL backup skipped because one is running',
      );

      release();
      await expect(first).resolves.toBe('success');
      await expect(service.runBackup()).resolves.toBe('success');
    });

    it('does nothing outside production', async () => {
      const { service, metrics } = build({ NODE_ENV: 'development' });
      await expect(service.runBackup()).resolves.toBe('skipped');
      expect(metrics.recordJob).not.toHaveBeenCalled();
    });
  });

  describe('scheduling', () => {
    it('schedules at the next UTC hour, runs the backup, and reschedules', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-03-04T05:30:00.000Z'));
      const { service, dump } = build();
      service.onModuleInit();
      expect(log).toHaveBeenCalledWith('Hourly PostgreSQL backups are enabled');

      await jest.advanceTimersByTimeAsync(29 * 60_000 + 59_999);
      expect(dump).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(dump).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(3_600_000);
      expect(dump).toHaveBeenCalledTimes(2);
      service.onModuleDestroy();
    });

    it('stops scheduling on destroy and re-enables after init', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-03-04T05:30:00.000Z'));
      const { service, dump } = build();
      service.onModuleInit();
      service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(7_200_000);
      expect(dump).not.toHaveBeenCalled();

      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(1_800_000);
      expect(dump).toHaveBeenCalledTimes(1);
      service.onModuleDestroy();
    });

    it('destroy is safe when nothing was scheduled', () => {
      const { service } = build({ NODE_ENV: 'development' });
      service.onModuleInit();
      expect(() => service.onModuleDestroy()).not.toThrow();
    });

    it('does not schedule when already stopped', () => {
      jest.useFakeTimers();
      const { service } = build();
      service.onModuleDestroy();
      (
        service as unknown as { scheduleNextBackup(): void }
      ).scheduleNextBackup();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('refuses to start in production without complete configuration', () => {
      const { service } = build({ MEDIA_S3_BUCKET: undefined });
      expect(() => service.onModuleInit()).toThrow(
        'Production database backup configuration is incomplete',
      );
    });
  });
});

describe('DatabaseBackupService design metadata under unresolved circular imports', () => {
  it('records Object for dependencies whose modules are not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('@nestjs/config', () => ({}));
      jest.doMock('../observability/managed-metrics.service', () => ({}));
      const {
        DatabaseBackupService: Isolated,
      } = require('./database-backup.service');
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
        Object,
        Object,
        Object,
      ]);
    });
  });
});
