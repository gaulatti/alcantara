import { createHash } from 'node:crypto';
import {
  DEMO_SONGS,
  DEMO_SONG_IDS,
  demoAudioClient,
  demoAudioUrl,
  seedDemoAudio,
} from './demo-audio';

// gaulatti/alcantara#206: each demo song's audio is uploaded to the local bucket and served from its public base,
// the one place a recovery playlist or a filler may read it from outside production.

const BASE = 'http://localstack.localhost:4566/alcantara-local-only';

const LOCAL = {
  NODE_ENV: 'development',
  MEDIA_S3_BUCKET: 'alcantara-local-only',
  MEDIA_S3_ENDPOINT: 'http://localstack:4566',
  LOCAL_MEDIA_PUBLIC_BASE_URL: BASE,
  AWS_REGION: 'us-east-1',
};

function fakeClient() {
  const sent: Array<{ input: Record<string, unknown> }> = [];
  return {
    sent,
    client: {
      send: async (command: { input: Record<string, unknown> }) => {
        sent.push(command);
        return {};
      },
    },
  };
}

const sha256 = (body: unknown) =>
  createHash('sha256')
    .update(body as Buffer)
    .digest('hex');

it('keeps the demo songs apart from the seeded songs, which keep their existing audio', () => {
  expect(new Set(DEMO_SONG_IDS).size).toBe(DEMO_SONG_IDS.length);
  for (const id of DEMO_SONG_IDS) {
    expect(id).toBeGreaterThan(9002);
  }
});

it('gives each demo song its own object key', () => {
  const keys = DEMO_SONGS.map((song) => song.key);
  expect(new Set(keys).size).toBe(DEMO_SONGS.length);
  for (const song of DEMO_SONGS) {
    expect(song.key).toContain(String(song.id));
  }
});

it('builds a demo audio URL under the public base, without a doubled slash', () => {
  expect(demoAudioUrl(`${BASE}/`, 'radio-demo/demo-tone-9101.ogg')).toBe(
    `${BASE}/radio-demo/demo-tone-9101.ogg`,
  );
});

it('uploads one tone per demo song to the local bucket and returns each song its own URL', async () => {
  const { sent, client } = fakeClient();
  const urls = await seedDemoAudio(LOCAL, client);
  expect(sent).toHaveLength(DEMO_SONGS.length);
  for (const [index, song] of DEMO_SONGS.entries()) {
    expect(urls.get(song.id)).toBe(`${BASE}/${song.key}`);
    expect(sent[index].input).toMatchObject({
      Bucket: 'alcantara-local-only',
      Key: song.key,
      ContentType: 'audio/ogg',
    });
    expect((sent[index].input.Body as Buffer).byteLength).toBeGreaterThan(0);
  }
  expect(new Set(urls.values()).size).toBe(DEMO_SONGS.length);
});

it('uploads a distinct tone for each demo song, so no two songs share a checksum', async () => {
  const { sent, client } = fakeClient();
  await seedDemoAudio(LOCAL, client);
  const checksums = sent.map((command) => sha256(command.input.Body));
  expect(new Set(checksums).size).toBe(DEMO_SONGS.length);
});

it('refuses to seed in production, before anything is uploaded', async () => {
  const { sent, client } = fakeClient();
  await expect(
    seedDemoAudio({ ...LOCAL, NODE_ENV: 'production' }, client),
  ).rejects.toThrow();
  expect(sent).toHaveLength(0);
});

it('names the variable that is missing, never its value', async () => {
  const { client } = fakeClient();
  await expect(
    seedDemoAudio({ ...LOCAL, LOCAL_MEDIA_PUBLIC_BASE_URL: undefined }, client),
  ).rejects.toThrow(
    'LOCAL_MEDIA_PUBLIC_BASE_URL must name the local media store',
  );
  await expect(
    seedDemoAudio({ ...LOCAL, MEDIA_S3_BUCKET: '  ' }, client),
  ).rejects.toThrow('MEDIA_S3_BUCKET is required');
  await expect(
    seedDemoAudio({ ...LOCAL, MEDIA_S3_BUCKET: undefined }, client),
  ).rejects.toThrow('MEDIA_S3_BUCKET is required');
  // Without an endpoint the existing local-media guard refuses a bucket first, and it names the variable.
  await expect(
    seedDemoAudio({ ...LOCAL, MEDIA_S3_ENDPOINT: undefined }, client),
  ).rejects.toThrow('MEDIA_S3_ENDPOINT');
});

it('refuses a public media base, even outside production', async () => {
  const { sent, client } = fakeClient();
  await expect(
    seedDemoAudio(
      {
        ...LOCAL,
        LOCAL_MEDIA_PUBLIC_BASE_URL: 'https://media.example.com/bucket',
      },
      client,
    ),
  ).rejects.toThrow();
  expect(sent).toHaveLength(0);
});

it('builds the client only for the local endpoint, and refuses without one', () => {
  expect(demoAudioClient(LOCAL)).toBeDefined();
  expect(demoAudioClient({ ...LOCAL, AWS_REGION: undefined })).toBeDefined();
  expect(() =>
    demoAudioClient({ ...LOCAL, MEDIA_S3_ENDPOINT: undefined }),
  ).toThrow('MEDIA_S3_ENDPOINT');
});
