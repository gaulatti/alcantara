import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  DATABASE_BACKUP_STORAGE,
  DATABASE_DUMP_RUNNER,
} from './database-backup.contracts';
import type {
  DatabaseBackupStorage,
  DatabaseDumpRunner,
} from './database-backup.contracts';

export const DATABASE_BACKUP_PREFIX = 'postgres-backups/alcantara';
const DATABASE_BACKUP_JOB = 'database-backup';

export function millisecondsUntilNextUtcHour(now: Date): number {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next.getTime() - now.getTime();
}

type BackupResult = 'success' | 'failure' | 'skipped';
type BackupStage = 'prepare' | 'dump' | 'upload' | 'cleanup';

@Injectable()
export class DatabaseBackupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseBackupService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly config: ConfigService,
    private readonly metrics: ManagedMetricsService,
    @Inject(DATABASE_DUMP_RUNNER)
    private readonly dumpRunner: DatabaseDumpRunner,
    @Inject(DATABASE_BACKUP_STORAGE)
    private readonly storage: DatabaseBackupStorage,
  ) {}

  onModuleInit(): void {
    if (!this.isProduction()) return;
    this.productionConfiguration();
    this.stopped = false;
    this.logger.log('Hourly PostgreSQL backups are enabled');
    this.scheduleNextBackup();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runBackup(): Promise<BackupResult> {
    if (!this.isProduction()) return 'skipped';

    if (this.running) {
      this.metrics.recordJob(DATABASE_BACKUP_JOB, 'skipped');
      this.logger.warn(
        'Hourly PostgreSQL backup skipped because one is running',
      );
      return 'skipped';
    }

    this.running = true;
    let directory: string | null = null;
    let stage: BackupStage = 'prepare';
    let successful = false;
    try {
      const configuration = this.productionConfiguration();
      directory = await mkdtemp(join(tmpdir(), 'alcantara-db-backup-'));
      const timestamp = new Date().toISOString().replaceAll(':', '-');
      const filename = `alcantara-${timestamp}.sql.gz`;
      const filePath = join(directory, filename);

      stage = 'dump';
      const dumpStartedAt = Date.now();
      try {
        await this.dumpRunner.dump(
          configuration.databaseUrl,
          filePath,
          directory,
        );
        this.metrics.recordDependency(
          'postgres',
          'read',
          'success',
          (Date.now() - dumpStartedAt) / 1000,
        );
      } catch {
        this.metrics.recordDependency(
          'postgres',
          'read',
          'failure',
          (Date.now() - dumpStartedAt) / 1000,
        );
        throw new Error('Database dump failed');
      }

      stage = 'upload';
      const uploadStartedAt = Date.now();
      try {
        await this.storage.upload({
          bucket: configuration.bucket,
          key: `${DATABASE_BACKUP_PREFIX}/${filename}`,
          filePath,
        });
        this.metrics.recordDependency(
          's3',
          'write',
          'success',
          (Date.now() - uploadStartedAt) / 1000,
        );
      } catch {
        this.metrics.recordDependency(
          's3',
          'write',
          'failure',
          (Date.now() - uploadStartedAt) / 1000,
        );
        throw new Error('Database backup upload failed');
      }

      successful = true;
    } catch {
      successful = false;
    } finally {
      if (directory) {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch {
          successful = false;
          stage = 'cleanup';
        }
      }
      this.running = false;
    }

    if (successful) {
      this.metrics.recordJob(DATABASE_BACKUP_JOB, 'success');
      this.logger.log('Hourly PostgreSQL backup completed');
      return 'success';
    }
    this.metrics.recordJob(DATABASE_BACKUP_JOB, 'failure');
    this.logger.error(`Hourly PostgreSQL backup failed during ${stage}`);
    return 'failure';
  }

  private isProduction(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production';
  }

  private productionConfiguration(): {
    databaseUrl: string;
    bucket: string;
  } {
    const databaseUrl = this.config.get<string>('DATABASE_URL')?.trim();
    const bucket = this.config.get<string>('MEDIA_S3_BUCKET')?.trim();
    const region = (
      this.config.get<string>('AWS_REGION') ??
      this.config.get<string>('AWS_DEFAULT_REGION')
    )?.trim();
    if (!databaseUrl || !bucket || !region) {
      throw new Error('Production database backup configuration is incomplete');
    }
    return { databaseUrl, bucket };
  }

  private scheduleNextBackup(): void {
    if (this.stopped) return;
    const delay = millisecondsUntilNextUtcHour(new Date());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scheduleNextBackup();
      void this.runBackup();
    }, delay);
    this.timer.unref();
  }
}
