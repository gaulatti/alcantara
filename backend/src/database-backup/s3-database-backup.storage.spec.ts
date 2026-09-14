import {
  HeadObjectCommand,
  PutObjectCommand,
  ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { S3DatabaseBackupStorage } from './s3-database-backup.storage';

describe('S3DatabaseBackupStorage', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 's3-db-backup-'));
    filePath = join(directory, 'backup.sql.gz');
    writeFileSync(filePath, 'compressed-backup');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('uploads with an integrity digest and verifies length and encryption', async () => {
    const file = await stat(filePath);
    let put: PutObjectCommand | undefined;
    const client = {
      send: jest.fn(async (command: PutObjectCommand | HeadObjectCommand) => {
        if (command instanceof PutObjectCommand) {
          put = command;
          for await (const chunk of command.input.Body as Readable) {
            // Consume the same streaming body the real SDK receives.
            void chunk;
          }
          return {};
        }
        return {
          ContentLength: file.size,
          ServerSideEncryption: ServerSideEncryption.AES256,
        };
      }),
    };
    const storage = new S3DatabaseBackupStorage(client);

    await expect(
      storage.upload({
        bucket: 'media-bucket',
        key: 'postgres-backups/alcantara/backup.sql.gz',
        filePath,
      }),
    ).resolves.toBeUndefined();

    expect(client.send).toHaveBeenCalledTimes(2);
    expect(put?.input).toMatchObject({
      Bucket: 'media-bucket',
      Key: 'postgres-backups/alcantara/backup.sql.gz',
      ContentLength: file.size,
      ContentType: 'application/gzip',
      ServerSideEncryption: ServerSideEncryption.AES256,
    });
    expect(put?.input.ContentMD5).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('fails when the uploaded object cannot be verified', async () => {
    const client = {
      send: jest.fn(async (command: PutObjectCommand | HeadObjectCommand) => {
        if (command instanceof PutObjectCommand) {
          for await (const chunk of command.input.Body as Readable) {
            // Consume the same streaming body the real SDK receives.
            void chunk;
          }
          return {};
        }
        return {
          ContentLength: 1,
          ServerSideEncryption: ServerSideEncryption.AES256,
        };
      }),
    };
    const storage = new S3DatabaseBackupStorage(client);

    await expect(
      storage.upload({
        bucket: 'media-bucket',
        key: 'postgres-backups/alcantara/backup.sql.gz',
        filePath,
      }),
    ).rejects.toThrow('Database backup upload or verification failed');
  });
});
