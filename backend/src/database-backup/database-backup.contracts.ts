export const DATABASE_DUMP_RUNNER = Symbol('DATABASE_DUMP_RUNNER');
export const DATABASE_BACKUP_STORAGE = Symbol('DATABASE_BACKUP_STORAGE');

export interface DatabaseDumpRunner {
  dump(
    databaseUrl: string,
    outputPath: string,
    workingDirectory: string,
  ): Promise<void>;
}

export interface DatabaseBackupStorage {
  upload(input: {
    bucket: string;
    key: string;
    filePath: string;
  }): Promise<void>;
}
