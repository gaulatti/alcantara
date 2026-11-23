import { UploadsService } from './uploads.service';

// gaulatti/alcantara#206: on the Compose stack the media bucket lives in a
// local store, so the S3 client targets it and upload URLs point at it.

const s3Configs: unknown[] = [];
const sendMock = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation((config: unknown) => {
    s3Configs.push(config);
    return { send: (...args: unknown[]) => sendMock(...args) };
  }),
  PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    input,
  })),
}));

jest.mock('music-metadata', () => ({ parseBuffer: jest.fn() }), {
  virtual: true,
});

const LOCAL = {
  NODE_ENV: 'development',
  MEDIA_S3_BUCKET: 'alcantara-local-only',
  MEDIA_S3_ENDPOINT: 'http://localstack:4566',
  LOCAL_MEDIA_PUBLIC_BASE_URL:
    'http://localstack.localhost:4566/alcantara-local-only',
};

function build(values: Record<string, string | undefined>) {
  return new UploadsService({
    get: jest.fn((key: string) => values[key]),
  } as never);
}

async function uploadSong(service: UploadsService) {
  return service.upload({
    kind: 'instant',
    buffer: Buffer.from('abc'),
    mimeType: 'audio/mpeg',
    originalFilename: 'Local Take.mp3',
  });
}

describe('UploadsService with the local media store', () => {
  beforeEach(() => {
    s3Configs.length = 0;
    sendMock.mockReset().mockResolvedValue({});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends objects to the local endpoint, path-style, and hands out local URLs', async () => {
    const result = await uploadSong(build(LOCAL));
    expect(s3Configs).toEqual([
      {
        region: 'us-east-1',
        endpoint: 'http://localstack:4566',
        forcePathStyle: true,
      },
    ]);
    expect(result.url).toMatch(
      /^http:\/\/localstack\.localhost:4566\/alcantara-local-only\/instant\/\d{4}\/\d{2}\/\d{2}\/local-take-[0-9a-f-]+\.mp3$/,
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('ignores both local-only variables in production', async () => {
    const result = await uploadSong(
      build({ ...LOCAL, NODE_ENV: 'production', MEDIA_S3_BUCKET: 'bkt' }),
    );
    expect(s3Configs).toEqual([{ region: 'us-east-1' }]);
    expect(result.url.startsWith('https://bkt.s3.amazonaws.com/')).toBe(true);
  });
});
