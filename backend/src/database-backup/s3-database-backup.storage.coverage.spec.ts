import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { S3DatabaseBackupStorage } from './s3-database-backup.storage';

const uploadFailure = 'Database backup upload or verification failed';

describe('S3DatabaseBackupStorage coverage', () => {
  let directory: string;
  let filePath: string;
  const content = 'compressed-backup';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 's3-db-cov-'));
    filePath = join(directory, 'backup.sql.gz');
    writeFileSync(filePath, content);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function clientReturning(head: {
    ContentLength?: number;
    ServerSideEncryption?: string;
  }) {
    return {
      send: jest.fn(async (command: PutObjectCommand | HeadObjectCommand) => {
        if (command instanceof PutObjectCommand) {
          for await (const chunk of command.input.Body as Readable) void chunk;
          return {};
        }
        return head;
      }),
    };
  }

  it('builds a regional S3 client with six attempts', async () => {
    const storage = S3DatabaseBackupStorage.forRegion('eu-west-2');
    const client = (storage as unknown as { client: S3Client }).client;
    expect(client).toBeInstanceOf(S3Client);
    await expect(client.config.region()).resolves.toBe('eu-west-2');
    await expect(client.config.maxAttempts()).resolves.toBe(6);
    client.destroy();
  });

  it('accepts an undefined region and defers resolution to the SDK chain', () => {
    const storage = S3DatabaseBackupStorage.forRegion(undefined);
    expect(storage).toBeInstanceOf(S3DatabaseBackupStorage);
    (storage as unknown as { client: S3Client }).client.destroy();
  });

  it('accepts an upload whose length and encryption match', async () => {
    const client = clientReturning({
      ContentLength: content.length,
      ServerSideEncryption: ServerSideEncryption.AES256,
    });
    await expect(
      new S3DatabaseBackupStorage(client).upload({
        bucket: 'b',
        key: 'k',
        filePath,
      }),
    ).resolves.toBeUndefined();
    expect(client.send).toHaveBeenCalledTimes(2);
    const head = client.send.mock.calls[1][0] as HeadObjectCommand;
    expect(head).toBeInstanceOf(HeadObjectCommand);
    expect(head.input).toEqual({ Bucket: 'b', Key: 'k' });
  });

  it('rejects when the stored length differs', async () => {
    const client = clientReturning({
      ContentLength: content.length + 1,
      ServerSideEncryption: ServerSideEncryption.AES256,
    });
    await expect(
      new S3DatabaseBackupStorage(client).upload({
        bucket: 'b',
        key: 'k',
        filePath,
      }),
    ).rejects.toThrow(uploadFailure);
  });

  it('rejects when the stored encryption differs', async () => {
    const client = clientReturning({
      ContentLength: content.length,
      ServerSideEncryption: 'aws:kms',
    });
    await expect(
      new S3DatabaseBackupStorage(client).upload({
        bucket: 'b',
        key: 'k',
        filePath,
      }),
    ).rejects.toThrow(uploadFailure);
  });

  it('wraps client failures in a generic error', async () => {
    const client = {
      send: jest.fn().mockRejectedValue(new Error('AccessDenied arn:secret')),
    };
    await expect(
      new S3DatabaseBackupStorage(client).upload({
        bucket: 'b',
        key: 'k',
        filePath,
      }),
    ).rejects.toThrow(new RegExp(`^${uploadFailure}$`));
  });

  it('rejects an empty artifact before contacting S3', async () => {
    writeFileSync(filePath, '');
    const client = { send: jest.fn() };
    await expect(
      new S3DatabaseBackupStorage(client).upload({
        bucket: 'b',
        key: 'k',
        filePath,
      }),
    ).rejects.toThrow('Database backup artifact is empty');
    expect(client.send).not.toHaveBeenCalled();
  });

  it('rejects a directory in place of an artifact', async () => {
    const client = { send: jest.fn() };
    await expect(
      new S3DatabaseBackupStorage(client).upload({
        bucket: 'b',
        key: 'k',
        filePath: directory,
      }),
    ).rejects.toThrow('Database backup artifact is empty');
    expect(client.send).not.toHaveBeenCalled();
  });
});
