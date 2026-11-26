import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  assertLocalMediaSafety,
  LOCAL_MEDIA_PUBLIC_BASE_URL,
  MEDIA_S3_ENDPOINT,
  readLocalMediaPublicBase,
  readMediaS3Endpoint,
} from '../config/local-media';

/**
 * Local demo audio for the seeded radio-demo songs (gaulatti/alcantara#206). A recovery playlist or a filler
 * downloads each song's audio, and the managed bucket is the only place it may come from. Outside production that
 * place is the Compose localstack, so the seed uploads one fictional tone there and gives the demo songs URLs under
 * LOCAL_MEDIA_PUBLIC_BASE_URL. The tone is generated for this repository; it is not a licensed recording.
 */

/** The demo songs the seed adds. The seeded songs 9001 and 9002 keep their existing audio. */
export const DEMO_SONG_IDS = [9101, 9102, 9103, 9104] as const;

/** The object key in the local bucket. */
export const DEMO_AUDIO_KEY = 'radio-demo/demo-tone.ogg';

/** The tone file, committed next to the seed so the Compose backend container, which mounts backend/prisma, has it. */
export const DEMO_AUDIO_FILE = join(__dirname, '..', '..', 'prisma', 'seed-audio', 'demo-tone.ogg');

export type DemoAudioEnvironment = Readonly<Record<string, string | undefined>>;

/** The URL the demo songs point at, built from the local public base. */
export function demoAudioUrl(publicBase: string): string {
  return `${publicBase.replace(/\/+$/, '')}/${DEMO_AUDIO_KEY}`;
}

/** The S3 client for the local store. Refuses without the local endpoint, so it never reaches AWS. */
export function demoAudioClient(environment: DemoAudioEnvironment): S3Client {
  const endpoint = readMediaS3Endpoint(environment);
  if (!endpoint) {
    throw new Error(`${MEDIA_S3_ENDPOINT} must name the local media store to seed the demo audio`);
  }
  return new S3Client({
    endpoint,
    region: environment.AWS_REGION ?? 'us-east-1',
    forcePathStyle: true,
  });
}

/**
 * Uploads the demo tone to the local bucket and returns the URL the demo songs should carry. Refuses to run in
 * production, outside a local media store, or without the variables that name one. Errors name the variable, never
 * its value.
 */
export async function seedDemoAudio(
  environment: DemoAudioEnvironment,
  s3: Pick<S3Client, 'send'>,
): Promise<string> {
  assertLocalMediaSafety(environment);
  const bucket = (environment.MEDIA_S3_BUCKET ?? '').trim();
  const publicBase = readLocalMediaPublicBase(environment);
  if (!bucket) throw new Error('MEDIA_S3_BUCKET is required to seed the demo audio');
  if (!publicBase) throw new Error(`${LOCAL_MEDIA_PUBLIC_BASE_URL} must name the local media store to seed the demo audio`);

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: DEMO_AUDIO_KEY,
      Body: readFileSync(DEMO_AUDIO_FILE),
      ContentType: 'audio/ogg',
    }),
  );
  return demoAudioUrl(publicBase);
}
