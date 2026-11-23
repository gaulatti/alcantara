import {
  assertLocalMediaSafety,
  isLocalHostname,
  isLocalMediaUrl,
  localMediaEnvironment,
  readLocalMediaPublicBase,
  readMediaS3Endpoint,
} from './local-media';

const LOCAL = {
  NODE_ENV: 'development',
  MEDIA_S3_BUCKET: 'alcantara-local-only',
  MEDIA_S3_ENDPOINT: 'http://localstack:4566',
  LOCAL_MEDIA_PUBLIC_BASE_URL:
    'http://localstack.localhost:4566/alcantara-local-only/',
};

// A value an operator might hold; it must never appear in an error.
const REAL_BUCKET = 'fictional-production-media-bucket';

function messageOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

describe('local media guard (gaulatti/alcantara#206)', () => {
  it('starts the Compose stack with a local bucket, endpoint and public base', () => {
    expect(() => assertLocalMediaSafety(LOCAL)).not.toThrow();
  });

  it('refuses a local start with a bucket but no local endpoint, naming only the variable', () => {
    const message = messageOf(() =>
      assertLocalMediaSafety({
        NODE_ENV: 'development',
        MEDIA_S3_BUCKET: REAL_BUCKET,
      }),
    );
    expect(message).toContain('MEDIA_S3_BUCKET');
    expect(message).not.toContain(REAL_BUCKET);
  });

  it('refuses a local start whose endpoint or public base is a public host', () => {
    const endpoint = messageOf(() =>
      assertLocalMediaSafety({
        ...LOCAL,
        MEDIA_S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com',
      }),
    );
    expect(endpoint).toContain('MEDIA_S3_ENDPOINT');
    expect(endpoint).not.toContain('amazonaws');

    const base = messageOf(() =>
      assertLocalMediaSafety({
        ...LOCAL,
        LOCAL_MEDIA_PUBLIC_BASE_URL: `https://${REAL_BUCKET}.s3.amazonaws.com`,
      }),
    );
    expect(base).toContain('LOCAL_MEDIA_PUBLIC_BASE_URL');
    expect(base).not.toContain(REAL_BUCKET);
  });

  it('refuses an endpoint that is not an http(s) URL or carries credentials', () => {
    for (const endpoint of [
      'not a url',
      'ftp://localstack:4566',
      'http://user:pass@localstack:4566',
    ]) {
      expect(() =>
        assertLocalMediaSafety({ ...LOCAL, MEDIA_S3_ENDPOINT: endpoint }),
      ).toThrow('MEDIA_S3_ENDPOINT must point at a local media store');
    }
  });

  it('allows a local run with no media bucket at all', () => {
    expect(() =>
      assertLocalMediaSafety({ NODE_ENV: 'development' }),
    ).not.toThrow();
    expect(() => assertLocalMediaSafety({})).not.toThrow();
  });

  it('refuses either local-only variable in production, naming only the variable', () => {
    for (const name of [
      'MEDIA_S3_ENDPOINT',
      'LOCAL_MEDIA_PUBLIC_BASE_URL',
    ] as const) {
      const message = messageOf(() =>
        assertLocalMediaSafety({
          NODE_ENV: 'production',
          MEDIA_S3_BUCKET: REAL_BUCKET,
          [name]: LOCAL[name],
        }),
      );
      expect(message).toBe(`${name} must not be set when NODE_ENV=production`);
    }
  });

  it('leaves production with a real bucket and neither variable unaffected', () => {
    expect(() =>
      assertLocalMediaSafety({
        NODE_ENV: 'production',
        MEDIA_S3_BUCKET: REAL_BUCKET,
      }),
    ).not.toThrow();
  });

  it('recognises only local hosts', () => {
    for (const host of [
      'localhost',
      'localstack.localhost',
      '127.0.0.1',
      '[::1]',
      'localstack',
    ]) {
      expect(isLocalHostname(host)).toBe(true);
    }
    for (const host of [
      '',
      's3.amazonaws.com',
      'media.example.com',
      '10.0.0.5',
      'fe80::1',
    ]) {
      expect(isLocalHostname(host)).toBe(false);
    }
  });

  it('reads the endpoint and public base only outside production', () => {
    expect(readMediaS3Endpoint(LOCAL)).toBe('http://localstack:4566');
    expect(readLocalMediaPublicBase(LOCAL)).toBe(
      'http://localstack.localhost:4566/alcantara-local-only',
    );
    const production = { ...LOCAL, NODE_ENV: 'production' };
    expect(readMediaS3Endpoint(production)).toBeUndefined();
    expect(readLocalMediaPublicBase(production)).toBeUndefined();
    expect(readMediaS3Endpoint({ NODE_ENV: 'development' })).toBeUndefined();
    expect(
      readMediaS3Endpoint({
        NODE_ENV: 'development',
        MEDIA_S3_ENDPOINT: 'https://s3.amazonaws.com',
      }),
    ).toBeUndefined();
    expect(
      readLocalMediaPublicBase({
        NODE_ENV: 'development',
        LOCAL_MEDIA_PUBLIC_BASE_URL: 'https://media.example.com',
      }),
    ).toBeUndefined();
  });

  it('accepts a media URL under the local base, and nothing else, only outside production', () => {
    const inside = new URL(
      'http://localstack.localhost:4566/alcantara-local-only/song/2026/11/17/a-1.mp3',
    );
    expect(isLocalMediaUrl(inside, LOCAL)).toBe(true);
    for (const outside of [
      'https://localstack.localhost:4566/alcantara-local-only/a.mp3',
      'http://localstack.localhost:4567/alcantara-local-only/a.mp3',
      'http://localstack.localhost:4566/other-bucket/a.mp3',
      'http://user:pass@localstack.localhost:4566/alcantara-local-only/a.mp3',
      'https://alcantara-local-only.s3.amazonaws.com/a.mp3',
    ]) {
      expect(isLocalMediaUrl(new URL(outside), LOCAL)).toBe(false);
    }
    expect(isLocalMediaUrl(inside, { ...LOCAL, NODE_ENV: 'production' })).toBe(
      false,
    );
    expect(isLocalMediaUrl(inside, { NODE_ENV: 'development' })).toBe(false);
  });

  it('reads its variables from a Nest ConfigService', () => {
    const values: Record<string, unknown> = { ...LOCAL, MEDIA_S3_BUCKET: 7 };
    const environment = localMediaEnvironment({
      get: <T>(name: string) => values[name] as T | undefined,
    });
    expect(environment).toEqual({
      NODE_ENV: 'development',
      MEDIA_S3_BUCKET: undefined,
      MEDIA_S3_ENDPOINT: LOCAL.MEDIA_S3_ENDPOINT,
      LOCAL_MEDIA_PUBLIC_BASE_URL: LOCAL.LOCAL_MEDIA_PUBLIC_BASE_URL,
    });
  });
});
