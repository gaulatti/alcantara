import { DEMO_AUDIO_KEY, DEMO_SONG_IDS, demoAudioClient, demoAudioUrl, seedDemoAudio } from './demo-audio';

// gaulatti/alcantara#206: the demo songs' audio is uploaded to the local bucket and served from its public base,
// the one place a recovery playlist or a filler may read it from outside production.

const LOCAL = {
  NODE_ENV: 'development',
  MEDIA_S3_BUCKET: 'alcantara-local-only',
  MEDIA_S3_ENDPOINT: 'http://localstack:4566',
  LOCAL_MEDIA_PUBLIC_BASE_URL: 'http://localstack.localhost:4566/alcantara-local-only',
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

it('keeps the demo songs apart from the seeded songs, which keep their existing audio', () => {
  expect(new Set(DEMO_SONG_IDS).size).toBe(DEMO_SONG_IDS.length);
  for (const id of DEMO_SONG_IDS) {
    expect(id).toBeGreaterThan(9002);
  }
});

it('builds the demo audio URL under the public base, without a doubled slash', () => {
  expect(demoAudioUrl('http://localstack.localhost:4566/alcantara-local-only/')).toBe(
    `http://localstack.localhost:4566/alcantara-local-only/${DEMO_AUDIO_KEY}`,
  );
});

it('uploads the tone to the local bucket and returns the URL the demo songs carry', async () => {
  const { sent, client } = fakeClient();
  const url = await seedDemoAudio(LOCAL, client);
  expect(url).toBe(`http://localstack.localhost:4566/alcantara-local-only/${DEMO_AUDIO_KEY}`);
  expect(sent).toHaveLength(1);
  expect(sent[0].input).toMatchObject({
    Bucket: 'alcantara-local-only',
    Key: DEMO_AUDIO_KEY,
    ContentType: 'audio/ogg',
  });
  expect((sent[0].input.Body as Buffer).byteLength).toBeGreaterThan(0);
});

it('refuses to seed in production, before anything is uploaded', async () => {
  const { sent, client } = fakeClient();
  await expect(seedDemoAudio({ ...LOCAL, NODE_ENV: 'production' }, client)).rejects.toThrow();
  expect(sent).toHaveLength(0);
});

it('names the variable that is missing, never its value', async () => {
  const { client } = fakeClient();
  await expect(seedDemoAudio({ ...LOCAL, LOCAL_MEDIA_PUBLIC_BASE_URL: undefined }, client)).rejects.toThrow(
    'LOCAL_MEDIA_PUBLIC_BASE_URL must name the local media store',
  );
  await expect(seedDemoAudio({ ...LOCAL, MEDIA_S3_BUCKET: '  ' }, client)).rejects.toThrow(
    'MEDIA_S3_BUCKET is required',
  );
  await expect(seedDemoAudio({ ...LOCAL, MEDIA_S3_BUCKET: undefined }, client)).rejects.toThrow(
    'MEDIA_S3_BUCKET is required',
  );
  // Without an endpoint the existing local-media guard refuses a bucket first, and it names the variable.
  await expect(seedDemoAudio({ ...LOCAL, MEDIA_S3_ENDPOINT: undefined }, client)).rejects.toThrow('MEDIA_S3_ENDPOINT');
});

it('refuses a public media base, even outside production', async () => {
  const { sent, client } = fakeClient();
  await expect(
    seedDemoAudio({ ...LOCAL, LOCAL_MEDIA_PUBLIC_BASE_URL: 'https://media.example.com/bucket' }, client),
  ).rejects.toThrow();
  expect(sent).toHaveLength(0);
});

it('builds the client only for the local endpoint, and refuses without one', () => {
  expect(demoAudioClient(LOCAL)).toBeDefined();
  expect(demoAudioClient({ ...LOCAL, AWS_REGION: undefined })).toBeDefined();
  expect(() => demoAudioClient({ ...LOCAL, MEDIA_S3_ENDPOINT: undefined })).toThrow('MEDIA_S3_ENDPOINT');
});
