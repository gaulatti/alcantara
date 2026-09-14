import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseBackupStorage } from './database-backup.contracts';

interface ObjectStorageClient {
  send(
    command: PutObjectCommand | HeadObjectCommand,
  ): Promise<{ ContentLength?: number; ServerSideEncryption?: string }>;
}

async function contentMd5(filePath: string): Promise<string> {
  const hash = createHash('md5');
  await pipeline(
    createReadStream(filePath),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback();
      },
    }),
  );
  return hash.digest('base64');
}

export class S3DatabaseBackupStorage implements DatabaseBackupStorage {
  constructor(private readonly client: ObjectStorageClient) {}

  static forRegion(region: string | undefined): S3DatabaseBackupStorage {
    return new S3DatabaseBackupStorage(
      new S3Client({ region, maxAttempts: 6 }) as ObjectStorageClient,
    );
  }

  async upload(input: {
    bucket: string;
    key: string;
    filePath: string;
  }): Promise<void> {
    const file = await stat(input.filePath);
    if (!file.isFile() || file.size === 0) {
      throw new Error('Database backup artifact is empty');
    }

    const encryption = ServerSideEncryption.AES256;
    const digest = await contentMd5(input.filePath);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          Body: createReadStream(input.filePath),
          ContentLength: file.size,
          ContentMD5: digest,
          ContentType: 'application/gzip',
          ServerSideEncryption: encryption,
        }),
      );
      const uploaded = await this.client.send(
        new HeadObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
        }),
      );
      if (
        uploaded.ContentLength !== file.size ||
        uploaded.ServerSideEncryption !== encryption
      ) {
        throw new Error('Database backup verification failed');
      }
    } catch {
      throw new Error('Database backup upload or verification failed');
    }
  }
}
