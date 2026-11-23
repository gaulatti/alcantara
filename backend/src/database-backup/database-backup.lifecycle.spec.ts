import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import * as files from 'node:fs/promises';
import { DatabaseBackupService } from './database-backup.service';
import type { ManagedMetricsService } from '../observability/managed-metrics.service';

jest.mock('node:fs/promises', () => ({
  ...jest.requireActual('node:fs/promises'),
  mkdtemp: jest.fn(),
  rm: jest.fn(),
}));

describe('hourly backup scheduling and platform failure boundaries', () => {
  function fixture(overrides: Record<string, string | undefined> = {}) {
    const configuration: Record<string, string | undefined> = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://fixture:local@local.invalid/fixture',
      MEDIA_S3_BUCKET: 'fixture-only-bucket',
      AWS_REGION: 'fixture-region',
      ...overrides,
    };
    const config = {
      get: (key: string) => configuration[key],
    } as unknown as ConfigService;
    const metrics = { recordJob: jest.fn(), recordDependency: jest.fn() };
    const dump = jest.fn().mockResolvedValue(undefined);
    const upload = jest.fn().mockResolvedValue(undefined);
    const service = new DatabaseBackupService(
      config,
      metrics as unknown as ManagedMetricsService,
      { dump },
      { upload },
    );
    return { service, configuration, metrics, dump, upload };
  }

  beforeEach(() => {
    (files.mkdtemp as jest.Mock)
      .mockReset()
      .mockResolvedValue('/fixture-only-backup');
    (files.rm as jest.Mock).mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('schedules at the next UTC hour, reschedules after execution and cancels the live timer on shutdown', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-24T12:59:59.000Z') });
    const { service, dump, upload, metrics } = fixture();
    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(999);
    expect(dump).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(dump).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'postgres-backups/alcantara/alcantara-2026-10-24T13-00-00.000Z.sql.gz',
      }),
    );
    expect(metrics.recordJob).toHaveBeenCalledWith(
      'database-backup',
      'success',
    );
    expect(jest.getTimerCount()).toBe(1);
    service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(3_600_000);
    expect(dump).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
  });

  it('can restart scheduling after an orderly module shutdown', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-24T12:59:59.999Z') });
    const { service, dump } = fixture();
    service.onModuleInit();
    service.onModuleDestroy();
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(1);
    expect(dump).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
  });

  it('records failed uploads without leaking storage errors and always removes its temporary directory', async () => {
    const { service, upload, metrics } = fixture();
    upload.mockRejectedValue(new Error('private storage endpoint details'));
    const error = jest.spyOn(Logger.prototype, 'error');
    await expect(service.runBackup()).resolves.toBe('failure');
    expect(metrics.recordDependency).toHaveBeenCalledWith(
      's3',
      'write',
      'failure',
      expect.any(Number),
    );
    expect(files.rm).toHaveBeenCalledWith('/fixture-only-backup', {
      recursive: true,
      force: true,
    });
    expect(error).toHaveBeenCalledWith(
      'Hourly PostgreSQL backup failed during upload',
    );
    expect(error).not.toHaveBeenCalledWith(
      expect.stringContaining('private storage'),
    );
    service.onModuleDestroy();
  });

  it('marks cleanup failure as failure and releases its running guard for the next attempt', async () => {
    (files.rm as jest.Mock)
      .mockRejectedValueOnce(new Error('filesystem busy'))
      .mockResolvedValue(undefined);
    const { service, dump, metrics } = fixture();
    await expect(service.runBackup()).resolves.toBe('failure');
    expect(metrics.recordJob).toHaveBeenLastCalledWith(
      'database-backup',
      'failure',
    );
    await expect(service.runBackup()).resolves.toBe('success');
    expect(dump).toHaveBeenCalledTimes(2);
    expect(metrics.recordJob).toHaveBeenLastCalledWith(
      'database-backup',
      'success',
    );
  });

  it('does not invoke dump, upload or cleanup when temporary directory creation fails', async () => {
    (files.mkdtemp as jest.Mock).mockRejectedValue(
      new Error('temporary storage full'),
    );
    const { service, dump, upload, metrics } = fixture();
    await expect(service.runBackup()).resolves.toBe('failure');
    expect(dump).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(files.rm).not.toHaveBeenCalled();
    expect(metrics.recordJob).toHaveBeenCalledWith(
      'database-backup',
      'failure',
    );
  });

  it.each(['DATABASE_URL', 'MEDIA_S3_BUCKET', 'AWS_REGION'])(
    'fails an incomplete %s configuration before touching temporary files',
    async (key) => {
      const { service, dump } = fixture({ [key]: undefined });
      await expect(service.runBackup()).resolves.toBe('failure');
      expect(files.mkdtemp).not.toHaveBeenCalled();
      expect(dump).not.toHaveBeenCalled();
    },
  );

  it('accepts AWS_DEFAULT_REGION when AWS_REGION is absent without constructing a remote client', async () => {
    const { service, upload } = fixture({
      AWS_REGION: undefined,
      AWS_DEFAULT_REGION: 'fixture-default-region',
    });
    await expect(service.runBackup()).resolves.toBe('success');
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
