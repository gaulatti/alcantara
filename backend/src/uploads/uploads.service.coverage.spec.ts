import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { parseBuffer } from 'music-metadata';
import { UploadsService } from './uploads.service';

const sendMock = jest.fn();
const regionsSeen: unknown[] = [];

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation((config: unknown) => {
    regionsSeen.push(config);
    return { send: (...args: unknown[]) => sendMock(...args) };
  }),
  PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    input,
  })),
}));

jest.mock('music-metadata', () => ({ parseBuffer: jest.fn() }), {
  virtual: true,
});

const parseBufferMock = parseBuffer as unknown as jest.Mock;

function build(env: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    MEDIA_S3_BUCKET: 'bkt',
    ...env,
  };
  const config = { get: jest.fn((key: string) => values[key]) };
  return new UploadsService(config as never);
}

const BUF = Buffer.from('abc');

describe('UploadsService (coverage)', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    sendMock.mockReset().mockResolvedValue({});
    parseBufferMock.mockReset();
    regionsSeen.length = 0;
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  describe('configuration', () => {
    it('fails when the bucket is missing', async () => {
      const service = build({ MEDIA_S3_BUCKET: undefined });
      await expect(
        service.upload({
          kind: 'instant',
          buffer: BUF,
          mimeType: 'audio/mpeg',
          originalFilename: 'a.mp3',
        }),
      ).rejects.toThrow(
        new InternalServerErrorException('MEDIA_S3_BUCKET is not configured'),
      );
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('trims the bucket and defaults the region to us-east-1', async () => {
      const service = build({ MEDIA_S3_BUCKET: '  bkt  ' });
      expect(regionsSeen).toEqual([{ region: 'us-east-1' }]);
      const result = await service.upload({
        kind: 'instant',
        buffer: BUF,
        mimeType: 'audio/mpeg',
        originalFilename: 'a.mp3',
      });
      expect(result.bucket).toBe('bkt');
      expect(result.url.startsWith('https://bkt.s3.amazonaws.com/')).toBe(true);
    });

    it('uses AWS_REGION first, then AWS_DEFAULT_REGION, then a blank falls back', async () => {
      build({ AWS_REGION: 'eu-west-1', AWS_DEFAULT_REGION: 'ap-south-1' });
      build({ AWS_DEFAULT_REGION: 'ap-south-1' });
      build({ AWS_REGION: '   ' });
      expect(regionsSeen).toEqual([
        { region: 'eu-west-1' },
        { region: 'ap-south-1' },
        { region: 'us-east-1' },
      ]);
    });

    it('builds regional URLs for non us-east-1 regions', async () => {
      const service = build({ AWS_REGION: 'eu-west-1' });
      const result = await service.upload({
        kind: 'artwork',
        buffer: BUF,
        mimeType: 'image/png',
        originalFilename: 'My Pic!.png',
      });
      expect(result.url).toMatch(
        /^https:\/\/bkt\.s3\.eu-west-1\.amazonaws\.com\/artwork\/\d{4}\/\d{2}\/\d{2}\/my-pic-[0-9a-f-]+\.png$/,
      );
    });
  });

  describe('validation', () => {
    const base = {
      buffer: BUF,
      kind: 'instant' as const,
      mimeType: 'audio/mpeg',
      originalFilename: 'a.mp3',
    };

    it('rejects empty buffers', async () => {
      await expect(
        build().upload({ ...base, buffer: Buffer.alloc(0) }),
      ).rejects.toThrow(new BadRequestException('Uploaded file is empty'));
    });

    it.each([
      ['instant', 100],
      ['background', 100],
      ['song', 100],
      ['stinger', 50],
      ['artwork', 10],
    ] as const)('rejects oversized %s uploads (%iMB)', async (kind, mb) => {
      const huge = { length: mb * 1024 * 1024 + 1 } as unknown as Buffer;
      await expect(
        build().upload({
          kind,
          buffer: huge,
          mimeType: kind === 'stinger' ? 'video/webm' : 'audio/mpeg',
          originalFilename: 'x.webm',
        }),
      ).rejects.toThrow(
        new BadRequestException(`File too large. Max size is ${mb}MB`),
      );
    });

    it.each([
      ['stinger', 'stinger video'],
      ['instant', 'audio'],
      ['artwork', 'image'],
    ] as const)('rejects unsupported %s type', async (kind, label) => {
      await expect(
        build().upload({
          kind,
          buffer: BUF,
          mimeType: 'application/pdf',
          originalFilename: 'doc.pdf',
        }),
      ).rejects.toThrow(
        new BadRequestException(`Unsupported ${label} file type`),
      );
    });

    it('rejects when neither mime nor extension is present', async () => {
      await expect(
        build().upload({
          ...base,
          mimeType: '',
          originalFilename: 'noext',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts an allowed extension even with an unknown mime type', async () => {
      const result = await build().upload({
        ...base,
        mimeType: 'application/octet-stream',
        originalFilename: 'A.MP3',
      });
      expect(result.contentType).toBe('application/octet-stream');
      expect(result.key).toMatch(/\.mp3$/);
    });

    it('accepts an allowed mime with an unknown extension', async () => {
      const result = await build().upload({
        ...base,
        mimeType: ' AUDIO/MPEG ',
        originalFilename: 'a.bin',
      });
      expect(result.contentType).toBe('audio/mpeg');
      expect(result.key).toMatch(/\.bin$/);
    });
  });

  describe('upload', () => {
    it('sends the object to S3 and reports the result', async () => {
      const service = build();
      const result = await service.upload({
        kind: 'stinger',
        buffer: BUF,
        mimeType: 'video/webm',
        originalFilename: 'Intro Clip.webm',
      });

      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock.mock.calls[0][0].input).toEqual({
        Bucket: 'bkt',
        Key: result.key,
        Body: BUF,
        ContentType: 'video/webm',
      });
      expect(result).toMatchObject({
        bucket: 'bkt',
        contentType: 'video/webm',
        sizeBytes: 3,
        metadata: undefined,
      });
      expect(result.key).toMatch(
        /^stinger\/\d{4}\/\d{2}\/\d{2}\/intro-clip-[0-9a-f-]+\.webm$/,
      );
    });

    it('falls back to per-kind default extension and content type', async () => {
      const service = build();
      const artwork = await service.upload({
        kind: 'artwork',
        buffer: BUF,
        mimeType: '',
        originalFilename: 'pic.png',
      });
      const stinger = await service.upload({
        kind: 'stinger',
        buffer: BUF,
        mimeType: '',
        originalFilename: 'x.webm',
      });
      const audio = await service.upload({
        kind: 'background',
        buffer: BUF,
        mimeType: '',
        originalFilename: 'x.wav',
      });
      expect(artwork.contentType).toBe('image/jpeg');
      expect(stinger.contentType).toBe('video/webm');
      expect(audio.contentType).toBe('audio/mpeg');

      const defaults = await Promise.all([
        service.upload({
          kind: 'artwork',
          buffer: BUF,
          mimeType: 'image/png',
          originalFilename: 'noext',
        }),
        service.upload({
          kind: 'stinger',
          buffer: BUF,
          mimeType: 'video/webm',
          originalFilename: 'noext',
        }),
        service.upload({
          kind: 'instant',
          buffer: BUF,
          mimeType: 'audio/mpeg',
          originalFilename: 'noext',
        }),
      ]);
      expect(defaults[0].key).toMatch(/\.jpg$/);
      expect(defaults[1].key).toMatch(/\.webm$/);
      expect(defaults[2].key).toMatch(/\.mp3$/);
    });

    it('uses "asset" when the sanitized base name is empty', async () => {
      const result = await build().upload({
        kind: 'instant',
        buffer: BUF,
        mimeType: 'audio/mpeg',
        originalFilename: '!!!.mp3',
      });
      expect(result.key).toMatch(/\/asset-[0-9a-f-]+\.mp3$/);
    });

    it('truncates long names and trims dashes', async () => {
      const result = await build().upload({
        kind: 'instant',
        buffer: BUF,
        mimeType: 'audio/mpeg',
        originalFilename: `--${'a'.repeat(60)}--.mp3`,
      });
      const base = result.key.split('/').pop() as string;
      expect(base.startsWith('a'.repeat(48) + '-')).toBe(true);
    });

    it('wraps S3 failures in an InternalServerErrorException', async () => {
      sendMock.mockRejectedValueOnce(new Error('boom'));
      await expect(
        build().upload({
          kind: 'instant',
          buffer: BUF,
          mimeType: 'audio/mpeg',
          originalFilename: 'a.mp3',
        }),
      ).rejects.toThrow(
        new InternalServerErrorException('Failed to upload file to S3'),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to upload object to S3',
        expect.any(Error),
      );
    });
  });

  describe('song metadata', () => {
    const song = (mimeType = 'audio/mpeg') => ({
      kind: 'song' as const,
      buffer: BUF,
      mimeType,
      originalFilename: 'song.mp3',
    });

    it('returns empty metadata when nothing can be extracted', async () => {
      parseBufferMock.mockResolvedValue({ common: {}, format: {} });
      const result = await build().upload(song());
      expect(result.metadata).toEqual({});
      expect(parseBufferMock).toHaveBeenCalledWith(BUF, 'audio/mpeg', {
        duration: true,
      });
    });

    it('returns empty metadata and warns when parsing throws', async () => {
      parseBufferMock.mockRejectedValue(new Error('bad'));
      const result = await build().upload(song(''));
      expect(result.metadata).toEqual({});
      expect(parseBufferMock).toHaveBeenCalledWith(BUF, '', {
        duration: true,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        'Unable to extract song metadata from upload',
        expect.any(Error),
      );
    });

    it('extracts artist, title, duration and uploads the cover', async () => {
      parseBufferMock.mockResolvedValue({
        common: {
          artist: ' Artist ',
          title: ' Title ',
          picture: [{ data: new Uint8Array([1, 2]), format: ' IMAGE/PNG ' }],
        },
        format: { duration: 1.2344 },
      });
      const result = await build().upload(song());
      expect(sendMock).toHaveBeenCalledTimes(2);
      const coverInput = sendMock.mock.calls[1][0].input;
      expect(coverInput.ContentType).toBe('image/png');
      expect(coverInput.Body).toEqual(Buffer.from([1, 2]));
      expect(coverInput.Key).toMatch(/^artwork\/.*song-[0-9a-f-]+\.png$/);
      expect(result.metadata).toEqual({
        artist: 'Artist',
        title: 'Title',
        durationMs: 1234,
        coverUrl: expect.stringContaining(coverInput.Key),
      });
    });

    it.each([
      ['image/avif', '.avif'],
      ['image/gif', '.gif'],
      ['image/jpg', '.jpg'],
      ['image/jpeg', '.jpg'],
      ['image/png', '.png'],
      ['image/webp', '.webp'],
      ['image/unknown', '.jpg'],
    ])('maps cover mime %s to %s', async (mime, ext) => {
      parseBufferMock.mockResolvedValue({
        common: { picture: [{ data: [9], format: mime }] },
        format: {},
      });
      await build().upload(song());
      expect(sendMock.mock.calls[1][0].input.Key.endsWith(ext)).toBe(true);
    });

    it('keeps metadata but drops the cover when the cover upload fails', async () => {
      parseBufferMock.mockResolvedValue({
        common: { title: 'T', picture: [{ data: [1], format: 'image/png' }] },
        format: {},
      });
      sendMock.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('x'));
      const result = await build().upload(song());
      expect(result.metadata).toEqual({
        artist: undefined,
        title: 'T',
        durationMs: undefined,
        coverUrl: undefined,
      });
      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to upload extracted song cover to S3',
        expect.any(Error),
      );
    });

    it('does not upload a cover without data or without a format', async () => {
      parseBufferMock.mockResolvedValueOnce({
        common: { title: 'A', picture: [{ format: 'image/png' }] },
        format: {},
      });
      parseBufferMock.mockResolvedValueOnce({
        common: { title: 'B', picture: [{ data: [1], format: '   ' }] },
        format: {},
      });
      parseBufferMock.mockResolvedValueOnce({
        common: { title: 'C', picture: [{ data: [1], format: 5 }] },
        format: {},
      });
      parseBufferMock.mockResolvedValueOnce({
        common: { title: 'D', picture: [] },
        format: {},
      });
      const service = build();
      for (const title of ['A', 'B', 'C', 'D']) {
        const result = await service.upload(song());
        expect(result.metadata).toMatchObject({ title, coverUrl: undefined });
      }
      // only the four primary uploads, no cover uploads
      expect(sendMock).toHaveBeenCalledTimes(4);
    });

    it('treats a data-only cover with no format as no upload but still metadata', async () => {
      parseBufferMock.mockResolvedValue({
        common: { picture: [{ data: [1] }] },
        format: {},
      });
      const result = await build().upload(song());
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(result.metadata).toMatchObject({ coverUrl: undefined });
    });

    it('falls back to the artists list for the artist', async () => {
      const service = build();
      parseBufferMock.mockResolvedValueOnce({
        common: { artist: '   ', artists: [' First ', 'Second'] },
        format: {},
      });
      parseBufferMock.mockResolvedValueOnce({
        common: { artists: ['   '], title: 't' },
        format: {},
      });
      parseBufferMock.mockResolvedValueOnce({
        common: { artists: [], title: 't' },
        format: {},
      });
      parseBufferMock.mockResolvedValueOnce({
        common: { artists: [undefined], title: 't' },
        format: {},
      });
      parseBufferMock.mockResolvedValueOnce({
        common: { artist: 5, title: ' ', artists: 'nope' },
        format: { duration: 1 },
      });
      expect((await service.upload(song())).metadata).toMatchObject({
        artist: 'First',
      });
      expect((await service.upload(song())).metadata).toMatchObject({
        artist: undefined,
      });
      expect((await service.upload(song())).metadata).toMatchObject({
        artist: undefined,
      });
      expect((await service.upload(song())).metadata).toMatchObject({
        artist: undefined,
      });
      expect((await service.upload(song())).metadata).toMatchObject({
        artist: undefined,
        title: undefined,
        durationMs: 1000,
      });
    });

    it.each([
      [0, undefined],
      [-1, undefined],
      [Number.NaN, undefined],
      [Number.POSITIVE_INFINITY, undefined],
      ['3', undefined],
      [0.0001, 1],
    ])('normalizes duration %p to %p', async (duration, expected) => {
      parseBufferMock.mockResolvedValue({
        common: { title: 'x' },
        format: { duration },
      });
      const result = await build().upload(song());
      expect(result.metadata?.durationMs).toBe(expected);
    });
  });
});

describe('UploadsService metadata (coverage)', () => {
  it('records Object as the paramtype when ConfigService is unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('@nestjs/config', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./uploads.service');
      expect(
        Reflect.getMetadata('design:paramtypes', mod.UploadsService),
      ).toEqual([Object]);
    });
    jest.dontMock('@nestjs/config');
  });
});
