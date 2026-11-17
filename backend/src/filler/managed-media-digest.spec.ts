import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { readManagedMediaDigest } from './managed-media-digest';

// gaulatti/alcantara#126: a filler source is read once from the managed media
// bucket and identified by its SHA-256; nothing else is accepted.

const config = (values: Record<string, string | undefined> = {}) =>
  new ConfigService({
    MEDIA_S3_BUCKET: 'media-test',
    AWS_REGION: 'us-east-1',
    ...values,
  });
const URL_A = 'https://media-test.s3.amazonaws.com/slate.png';

describe('readManagedMediaDigest', () => {
  afterEach(() => jest.restoreAllMocks());
  const serve = (response: Response | Promise<Response>) =>
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(response));

  it('returns the SHA-256 of the object at either bucket host style', async () => {
    const fetch = serve(new Response('slate bytes'));
    const digest = createHash('sha256').update('slate bytes').digest('hex');
    await expect(
      readManagedMediaDigest(URL_A, config(), 'television filler'),
    ).resolves.toBe(digest);
    expect(fetch).toHaveBeenCalledWith(
      URL_A,
      expect.objectContaining({ redirect: 'error' }),
    );
    serve(new Response('slate bytes'));
    await expect(
      readManagedMediaDigest(
        'https://media-test.s3.us-east-1.amazonaws.com/slate.png',
        config(),
        'television filler',
      ),
    ).resolves.toBe(digest);
  });

  it('needs a configured managed bucket', async () => {
    await expect(
      readManagedMediaDigest(
        URL_A,
        config({ MEDIA_S3_BUCKET: ' ' }),
        'radio filler',
      ),
    ).rejects.toThrow(
      new BadRequestException('managed media bucket is unavailable'),
    );
    await expect(
      readManagedMediaDigest(URL_A, new ConfigService({}), 'radio filler'),
    ).rejects.toThrow('managed media bucket is unavailable');
  });

  it.each([
    ['not a URL', 'radio filler source has an invalid URL'],
    [
      'http://media-test.s3.amazonaws.com/a.mp3',
      'radio filler source must use the managed media bucket',
    ],
    [
      'https://other.s3.amazonaws.com/a.mp3',
      'radio filler source must use the managed media bucket',
    ],
    [
      'https://user@media-test.s3.amazonaws.com/a.mp3',
      'radio filler source must use the managed media bucket',
    ],
    [
      'https://u:p@media-test.s3.amazonaws.com/a.mp3',
      'radio filler source must use the managed media bucket',
    ],
    [
      'https://media-test.s3.amazonaws.com:8443/a.mp3',
      'radio filler source must use the managed media bucket',
    ],
  ])('refuses %s without reading it', async (url, message) => {
    const fetch = jest.spyOn(globalThis, 'fetch');
    await expect(
      readManagedMediaDigest(url, config(), 'radio filler'),
    ).rejects.toThrow(message);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports an unreadable, missing, oversized or empty object', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
    await expect(
      readManagedMediaDigest(URL_A, config(), 'radio filler'),
    ).rejects.toThrow(
      new BadRequestException('radio filler source could not be read'),
    );
    serve(new Response('', { status: 404 }));
    await expect(
      readManagedMediaDigest(URL_A, config(), 'radio filler'),
    ).rejects.toThrow('radio filler source could not be read');
    serve(new Response(null));
    await expect(
      readManagedMediaDigest(URL_A, config(), 'radio filler'),
    ).rejects.toThrow('radio filler source could not be read');
    serve(new Response(''));
    await expect(
      readManagedMediaDigest(URL_A, config(), 'radio filler'),
    ).rejects.toThrow('radio filler source is empty');
    const cancel = jest.fn().mockResolvedValue(undefined);
    const huge = new Uint8Array(512 * 1024 * 1024 + 1);
    serve({
      ok: true,
      body: Object.assign(
        (function* () {
          yield huge;
        })(),
        { cancel },
      ),
    } as unknown as Response);
    await expect(
      readManagedMediaDigest(URL_A, config(), 'radio filler'),
    ).rejects.toThrow('radio filler source exceeds 512 MiB');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('maps a read error mid-stream to a bad gateway', async () => {
    serve({
      ok: true,
      body: (function* () {
        yield new Uint8Array([1]);
        throw new Error('connection reset');
      })(),
    } as unknown as Response);
    await expect(
      readManagedMediaDigest(URL_A, config(), 'radio filler'),
    ).rejects.toThrow(
      new BadGatewayException('radio filler source could not be read'),
    );
  });

  describe('local media store (gaulatti/alcantara#206)', () => {
    const local = {
      MEDIA_S3_BUCKET: 'alcantara-local-only',
      LOCAL_MEDIA_PUBLIC_BASE_URL:
        'http://localstack.localhost:4566/alcantara-local-only',
    };
    const LOCAL_URL =
      'http://localstack.localhost:4566/alcantara-local-only/slate.png';

    it('reads an object under the local base outside production', async () => {
      serve(new Response('slate bytes'));
      await expect(
        readManagedMediaDigest(
          LOCAL_URL,
          config({ ...local, NODE_ENV: 'development' }),
          'television filler',
        ),
      ).resolves.toBe(createHash('sha256').update('slate bytes').digest('hex'));
    });

    it('refuses the local base in production and keeps only the bucket hosts', async () => {
      const fetch = serve(new Response('slate bytes'));
      const production = config({ ...local, NODE_ENV: 'production' });
      await expect(
        readManagedMediaDigest(LOCAL_URL, production, 'television filler'),
      ).rejects.toThrow(
        new BadRequestException(
          'television filler source must use the managed media bucket',
        ),
      );
      expect(fetch).not.toHaveBeenCalled();
      serve(new Response('slate bytes'));
      await expect(
        readManagedMediaDigest(
          'https://alcantara-local-only.s3.amazonaws.com/slate.png',
          production,
          'television filler',
        ),
      ).resolves.toBe(createHash('sha256').update('slate bytes').digest('hex'));
    });
  });
});
