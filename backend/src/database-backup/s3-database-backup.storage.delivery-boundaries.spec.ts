import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3DatabaseBackupStorage } from './s3-database-backup.storage';

describe('local backup artifact admission before object-storage access', () => {
  it.each(['empty-file', 'directory'] as const)(
    'rejects a local %s without an upload request',
    async (kind) => {
      const directory = await mkdtemp(
        join(tmpdir(), 'alcantara-artifact-boundary-'),
      );
      const send = jest.fn();
      const storage = new S3DatabaseBackupStorage({ send });
      try {
        const filePath =
          kind === 'directory' ? directory : join(directory, 'empty.sql.gz');
        if (kind === 'empty-file') await writeFile(filePath, '');
        await expect(
          storage.upload({
            bucket: 'fixture-only',
            key: 'backup.sql.gz',
            filePath,
          }),
        ).rejects.toThrow('Database backup artifact is empty');
        expect(send).not.toHaveBeenCalled();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
