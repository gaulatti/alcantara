import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { parseBuffer } from 'music-metadata';
import { UploadsService } from './uploads.service';

// music-metadata is ESM-only; Jest's CommonJS test runner replaces its external
// parser boundary explicitly while exercising the real upload implementation.
jest.mock('music-metadata', () => ({ parseBuffer: jest.fn() }), {
  virtual: true,
});

describe('UploadsService validation and storage boundary', () => {
  let send: jest.SpyInstance;
  const buffer = Buffer.from('fictional upload bytes');
  const payload = (extra: Record<string, unknown> = {}) => ({
    kind: 'instant' as const,
    buffer,
    mimeType: 'audio/mpeg',
    originalFilename: 'Station Ident.MP3',
    ...extra,
  });
  const service = (
    values: Record<string, string> = { MEDIA_S3_BUCKET: 'test-media' },
  ) => new UploadsService({ get: (key: string) => values[key] } as any);

  beforeEach(() => {
    send = jest
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({} as never);
    (parseBuffer as jest.Mock)
      .mockReset()
      .mockResolvedValue({ common: {}, format: {} });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.useFakeTimers().setSystemTime(new Date('2026-01-02T03:04:05Z'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('stores the original bytes with a canonical safe object key and truthful public metadata', async () => {
    const result = await service().upload(payload());
    expect(result.key).toMatch(
      /^instant\/2026\/01\/02\/station-ident-[a-f0-9-]{36}\.mp3$/,
    );
    expect(result).toEqual({
      key: result.key,
      url: `https://test-media.s3.amazonaws.com/${result.key}`,
      bucket: 'test-media',
      contentType: 'audio/mpeg',
      sizeBytes: buffer.length,
      metadata: undefined,
    });
    expect(send.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: 'test-media',
      Key: result.key,
      Body: buffer,
      ContentType: 'audio/mpeg',
    });
    expect(parseBuffer).not.toHaveBeenCalled();
  });

  it.each([
    ['background', 'audio/wav', 'name.wav', '.wav'],
    ['artwork', 'image/png', 'name.png', '.png'],
    ['stinger', 'video/webm', 'name.webm', '.webm'],
    ['instant', 'audio/mpeg', 'no-extension', '.mp3'],
    ['artwork', 'image/jpeg', 'no-extension', '.jpg'],
    ['stinger', 'video/webm', 'no-extension', '.webm'],
  ])(
    'accepts the supported %s content family and chooses a native/default extension',
    async (kind, mimeType, originalFilename, extension) => {
      const result = await service().upload(
        payload({ kind, mimeType, originalFilename }) as any,
      );
      expect(result.key.endsWith(extension)).toBe(true);
      expect(send.mock.calls[0][0].input.ContentType).toBe(mimeType);
    },
  );

  it.each([
    ['instant', 'ident.mp3', 'audio/mpeg'],
    ['artwork', 'art.jpg', 'image/jpeg'],
    ['stinger', 'transition.webm', 'video/webm'],
  ])(
    'accepts extension-identified %s uploads without inventing their bytes',
    async (kind, originalFilename, expectedMime) => {
      const result = await service().upload(
        payload({ kind, originalFilename, mimeType: '' }) as any,
      );
      expect(result.contentType).toBe(expectedMime);
      expect(send.mock.calls[0][0].input.Body).toBe(buffer);
    },
  );

  it('normalizes MIME casing, regional configuration and filenames without exposing source paths', async () => {
    const result = await service({
      MEDIA_S3_BUCKET: ' test-media ',
      AWS_DEFAULT_REGION: 'eu-west-1',
    }).upload(
      payload({
        mimeType: ' AUDIO/MP3 ',
        originalFilename: '../Fictional Station/Ident.mp3',
      }),
    );
    expect(result.contentType).toBe('audio/mp3');
    expect(result.url).toBe(
      `https://test-media.s3.eu-west-1.amazonaws.com/${result.key}`,
    );
    expect(result.key).not.toContain('..');
    expect(result.key).not.toContain('Station/');
    const generic = await service({
      MEDIA_S3_BUCKET: 'test-media',
      AWS_REGION: '   ',
    }).upload(payload({ originalFilename: '!!!.mp3' }));
    expect(generic.key).toMatch(/\/asset-[a-f0-9-]{36}\.mp3$/);
    expect(generic.url).toContain('.s3.amazonaws.com/');
  });

  it('rejects missing storage configuration and empty files before any object write', async () => {
    await expect(service({}).upload(payload())).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    await expect(
      service().upload(payload({ buffer: Buffer.alloc(0) })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['instant', 'file.txt', 'text/plain', 'audio'],
    ['background', 'file.png', 'image/png', 'audio'],
    ['song', 'file.txt', '', 'audio'],
    ['artwork', 'file.mp3', 'audio/mpeg', 'image'],
    ['stinger', 'file.mp4', 'video/mp4', 'stinger video'],
  ])(
    'rejects unsupported %s content before storage',
    async (kind, originalFilename, mimeType, label) => {
      await expect(
        service().upload(payload({ kind, originalFilename, mimeType }) as any),
      ).rejects.toThrow(`Unsupported ${label} file type`);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['instant', 100],
    ['song', 100],
    ['artwork', 10],
    ['stinger', 50],
  ])(
    'rejects %s bytes above its size boundary before storage',
    async (kind, limitMb) => {
      const large = Buffer.alloc(Number(limitMb) * 1024 * 1024 + 1);
      await expect(
        service().upload(payload({ kind, buffer: large }) as any),
      ).rejects.toThrow(`Max size is ${limitMb}MB`);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('maps an object-store outage to a failed upload and does not parse metadata for an unstored song', async () => {
    send.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(
      service().upload(payload({ kind: 'song' }) as any),
    ).rejects.toThrow('Failed to upload file to S3');
    expect(parseBuffer).not.toHaveBeenCalled();
  });

  it('extracts normalized tags, duration and embedded artwork after the original song is stored', async () => {
    const cover = Uint8Array.from([1, 2, 3]);
    (parseBuffer as jest.Mock).mockResolvedValue({
      common: {
        artist: ' Artist ',
        title: ' Title ',
        picture: [{ format: ' IMAGE/PNG ', data: cover }],
      },
      format: { duration: 1.2344 },
    });
    const result = await service().upload(payload({ kind: 'song' }) as any);
    expect(parseBuffer).toHaveBeenCalledWith(buffer, 'audio/mpeg', {
      duration: true,
    });
    expect(send).toHaveBeenCalledTimes(2);
    const coverInput = send.mock.calls[1][0].input;
    expect(coverInput.Key).toMatch(
      /^artwork\/2026\/01\/02\/station-ident-[a-f0-9-]{36}\.png$/,
    );
    expect(coverInput.Body).toEqual(Buffer.from(cover));
    expect(coverInput.ContentType).toBe('image/png');
    expect(result.metadata).toEqual({
      artist: 'Artist',
      title: 'Title',
      durationMs: 1234,
      coverUrl: `https://test-media.s3.amazonaws.com/${coverInput.Key}`,
    });
  });

  it('uses the first artist only when the primary tag is blank and keeps a successfully stored song when cover upload fails', async () => {
    (parseBuffer as jest.Mock).mockResolvedValue({
      common: {
        artist: ' ',
        artists: [' First Artist ', 'Second'],
        title: '',
        picture: [{ format: 'unknown/image', data: [1] }],
      },
      format: { duration: 0.0001 },
    });
    send
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('cover unavailable'));
    const result = await service().upload(payload({ kind: 'song' }) as any);
    expect(result.metadata).toEqual({
      artist: 'First Artist',
      title: undefined,
      durationMs: 1,
      coverUrl: undefined,
    });
    expect(send.mock.calls[1][0].input.Key.endsWith('.jpg')).toBe(true);
    expect(console.error).toHaveBeenCalledWith(
      'Failed to upload extracted song cover to S3',
      expect.any(Error),
    );
  });

  it.each(['image/avif', 'image/gif', 'image/jpg', 'image/jpeg', 'image/webp'])(
    'preserves the supported embedded cover format %s',
    async (format) => {
      (parseBuffer as jest.Mock).mockResolvedValue({
        common: { picture: [{ format, data: [1] }] },
        format: {},
      });
      const result = await service().upload(payload({ kind: 'song' }) as any);
      const extensions: Record<string, string> = {
        'image/avif': '.avif',
        'image/gif': '.gif',
        'image/jpg': '.jpg',
        'image/jpeg': '.jpg',
        'image/webp': '.webp',
      };
      expect(send.mock.calls[1][0].input.Key.endsWith(extensions[format])).toBe(
        true,
      );
      expect(result.metadata?.coverUrl).toBeDefined();
    },
  );

  it.each([
    { common: {}, format: {} },
    { common: { artists: [], picture: [] }, format: { duration: Infinity } },
    { common: { artists: ['  '], title: ' ' }, format: { duration: -1 } },
  ])(
    'returns empty metadata when tags are absent or unusable',
    async (metadata) => {
      (parseBuffer as jest.Mock).mockResolvedValue(metadata);
      expect(
        (await service().upload(payload({ kind: 'song' }) as any)).metadata,
      ).toEqual({});
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it('returns an uploaded song without metadata when parsing fails', async () => {
    (parseBuffer as jest.Mock).mockRejectedValue(new Error('malformed audio'));
    expect(
      (await service().upload(payload({ kind: 'song', mimeType: '' }) as any))
        .metadata,
    ).toEqual({});
    expect(console.warn).toHaveBeenCalledWith(
      'Unable to extract song metadata from upload',
      expect.any(Error),
    );
  });
});
