import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DATABASE_BACKUP_STORAGE,
  DATABASE_DUMP_RUNNER,
} from './database-backup.contracts';
import { DatabaseBackupService } from './database-backup.service';
import { PgDumpRunner } from './pg-dump.runner';
import { S3DatabaseBackupStorage } from './s3-database-backup.storage';

@Module({
  providers: [
    DatabaseBackupService,
    {
      provide: DATABASE_DUMP_RUNNER,
      useFactory: () => new PgDumpRunner(),
    },
    {
      provide: DATABASE_BACKUP_STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        S3DatabaseBackupStorage.forRegion(
          config.get<string>('AWS_REGION') ??
            config.get<string>('AWS_DEFAULT_REGION'),
        ),
    },
  ],
})
export class DatabaseBackupModule {}
