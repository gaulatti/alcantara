import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { isLocalMediaUrl, localMediaEnvironment } from '../config/local-media';

const MAX_BYTES = 512 * 1024 * 1024;

/**
 * Reads a managed-bucket media object once and returns its SHA-256, the
 * checksum a filler version records (gaulatti/alcantara#126). Only the
 * managed media bucket is accepted, over https, without credentials or a
 * port, and the object must be 1 byte to 512 MiB. The URL itself is never
 * stored.
 */
export async function readManagedMediaDigest(
  sourceUrl: string,
  config: ConfigService,
  label: string,
): Promise<string> {
  const bucket = config.get<string>('MEDIA_S3_BUCKET')?.trim();
  if (!bucket) {
    throw new BadRequestException('managed media bucket is unavailable');
  }
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new BadRequestException(`${label} source has an invalid URL`);
  }
  const isManagedBucketUrl =
    url.protocol === 'https:' &&
    [
      `${bucket}.s3.amazonaws.com`,
      `${bucket}.s3.${config.get<string>('AWS_REGION')}.amazonaws.com`,
    ].includes(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.port;
  // Outside production only, the Compose stack's local media store
  // (gaulatti/alcantara#206).
  if (
    !isManagedBucketUrl &&
    !isLocalMediaUrl(url, localMediaEnvironment(config))
  ) {
    throw new BadRequestException(
      `${label} source must use the managed media bucket`,
    );
  }
  const response = await fetch(sourceUrl, {
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  }).catch(() => {
    throw new BadRequestException(`${label} source could not be read`);
  });
  if (!response.ok || !response.body) {
    throw new BadRequestException(`${label} source could not be read`);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_BYTES) {
        await response.body.cancel().catch(() => undefined);
        throw new BadRequestException(`${label} source exceeds 512 MiB`);
      }
      hash.update(chunk);
    }
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadGatewayException(`${label} source could not be read`);
  }
  if (bytes === 0) {
    throw new BadRequestException(`${label} source is empty`);
  }
  return hash.digest('hex');
}
