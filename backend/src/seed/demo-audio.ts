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
 * Local demo audio for the seeded radio-demo songs (gaulatti/alcantara#206). A recovery playlist or a filler downloads each
 * song's audio, and the managed bucket is the only place it may come from. Outside production that place is the Compose
 * localstack, so the seed uploads one fictional tone per demo song there and gives each song its own URL under
 * LOCAL_MEDIA_PUBLIC_BASE_URL. Each tone is a different pitch, so each song has its own bytes and checksum and a walk can
 * attribute a played file to exactly one song. The tones are generated for this repository; they are not licensed recordings.
 */

/** One demo song: its id, its tone file committed next to the seed, and its object key in the local bucket. */
export interface DemoSong {
  readonly id: number;
  readonly file: string;
  readonly key: string;
}

/** The demo songs the seed adds, one tone each. The seeded songs 9001 and 9002 keep their existing audio. */
export const DEMO_SONGS: readonly DemoSong[] = [
  {
    id: 9101,
    file: 'demo-tone-9101.ogg',
    key: 'radio-demo/demo-tone-9101.ogg',
  },
  {
    id: 9102,
    file: 'demo-tone-9102.ogg',
    key: 'radio-demo/demo-tone-9102.ogg',
  },
  {
    id: 9103,
    file: 'demo-tone-9103.ogg',
    key: 'radio-demo/demo-tone-9103.ogg',
  },
  {
    id: 9104,
    file: 'demo-tone-9104.ogg',
    key: 'radio-demo/demo-tone-9104.ogg',
  },
];

/** The demo song ids, in seed order. */
export const DEMO_SONG_IDS = DEMO_SONGS.map((song) => song.id);

/** The directory the tone files are committed in. The Compose backend container mounts backend/prisma, so it has them. */
export const DEMO_AUDIO_DIR = join(
  __dirname,
  '..',
  '..',
  'prisma',
  'seed-audio',
);

export type DemoAudioEnvironment = Readonly<Record<string, string | undefined>>;

/** The URL a demo song points at, built from the local public base. */
export function demoAudioUrl(publicBase: string, key: string): string {
  return `${publicBase.replace(/\/+$/, '')}/${key}`;
}

/** The S3 client for the local store. Refuses without the local endpoint, so it never reaches AWS. */
export function demoAudioClient(environment: DemoAudioEnvironment): S3Client {
  const endpoint = readMediaS3Endpoint(environment);
  if (!endpoint) {
    throw new Error(
      `${MEDIA_S3_ENDPOINT} must name the local media store to seed the demo audio`,
    );
  }
  return new S3Client({
    endpoint,
    region: environment.AWS_REGION ?? 'us-east-1',
    forcePathStyle: true,
  });
}

/**
 * Uploads each demo song's tone to the local bucket and returns the URL each demo song should carry, keyed by song id.
 * Refuses to run in production, outside a local media store, or without the variables that name one. Errors name the
 * variable, never its value.
 */
export async function seedDemoAudio(
  environment: DemoAudioEnvironment,
  s3: Pick<S3Client, 'send'>,
): Promise<Map<number, string>> {
  assertLocalMediaSafety(environment);
  const bucket = (environment.MEDIA_S3_BUCKET ?? '').trim();
  const publicBase = readLocalMediaPublicBase(environment);
  if (!bucket)
    throw new Error('MEDIA_S3_BUCKET is required to seed the demo audio');
  if (!publicBase)
    throw new Error(
      `${LOCAL_MEDIA_PUBLIC_BASE_URL} must name the local media store to seed the demo audio`,
    );

  const urls = new Map<number, string>();
  for (const song of DEMO_SONGS) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: song.key,
        Body: readFileSync(join(DEMO_AUDIO_DIR, song.file)),
        ContentType: 'audio/ogg',
      }),
    );
    urls.set(song.id, demoAudioUrl(publicBase, song.key));
  }
  return urls;
}
