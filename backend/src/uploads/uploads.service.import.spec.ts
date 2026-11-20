/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access -- the S3 client and the tag parser are mocked. */
import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
} from '@nestjs/common';
import { parseBuffer } from 'music-metadata';
import { MAX_IMPORT_BYTES, UploadsService } from './uploads.service';
import { scriptedTransport } from '../outbound/safe-fetch.testing';

// Import by address: the fetch is the outbound-request policy's (every refusal
// is the policy's), the store is upload()'s, and the address is never kept.

const sendMock = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: (...args: unknown[]) => sendMock(...args),
  })),
  PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    input,
  })),
}));
jest.mock('music-metadata', () => ({ parseBuffer: jest.fn() }), {
  virtual: true,
});
const parseBufferMock = parseBuffer as unknown as jest.Mock;

const SECRET_HOST = 'media.example.com';
const names = {
  [SECRET_HOST]: ['93.184.216.34'],
  'internal.example.com': ['10.0.0.5'],
  'bounce.example.com': ['93.184.216.34'],
};

function build(script: Parameters<typeof scriptedTransport>[1]) {
  const recorded: Array<[string, string]> = [];
  const metrics = {
    recordOutboundFetch: (path: string, result: string) =>
      recorded.push([path, result]),
  };
  const config = {
    get: jest.fn((key: string) =>
      key === 'MEDIA_S3_BUCKET' ? 'bkt' : undefined,
    ),
  };
  const service = new UploadsService(config as never, metrics as never);
  const transport = scriptedTransport(names, script);
  service.outboundDeps = transport;
  return { service, recorded, transport };
}

const audio = (
  type = 'audio/mpeg',
  body = [Buffer.from('ID3'), Buffer.from('x')],
) => ({
  status: 200,
  headers: { 'content-type': type },
  body,
});

describe('UploadsService.importFromUrl', () => {
  let logs: jest.SpyInstance[];
  beforeEach(() => {
    sendMock.mockReset().mockResolvedValue({});
    parseBufferMock.mockReset();
    logs = [
      jest.spyOn(console, 'error').mockImplementation(() => {}),
      jest.spyOn(console, 'warn').mockImplementation(() => {}),
      jest.spyOn(console, 'log').mockImplementation(() => {}),
    ];
  });
  afterEach(() => logs.forEach((spy) => spy.mockRestore()));

  it('fetches under the policy and stores the bytes as the console stores an upload', async () => {
    const { service, recorded, transport } = build({
      [`${SECRET_HOST}/a/Loud%20Song.mp3?x=1`]: audio(),
    });
    const result = await service.importFromUrl({
      kind: 'instant',
      url: `https://${SECRET_HOST}/a/Loud%20Song.mp3?x=1`,
    });
    expect(result).toMatchObject({
      bucket: 'bkt',
      contentType: 'audio/mpeg',
      sizeBytes: 4,
    });
    expect(result.key).toMatch(
      /^instant\/\d{4}\/\d{2}\/\d{2}\/loud-song-.+\.mp3$/,
    );
    const put = sendMock.mock.calls[0][0] as { input: { Body: Buffer } };
    expect(put.input.Body.toString()).toBe('ID3x');
    expect(transport.sent[0].connectedTo).toBe('93.184.216.34');
    expect(recorded).toEqual([['media_import', 'ok']]);
  });

  it('reads the tags of a song, as a song upload does', async () => {
    parseBufferMock.mockResolvedValue({
      common: { artist: 'A', title: 'T' },
      format: { duration: 2 },
    });
    const { service } = build({ [`${SECRET_HOST}/s.mp3`]: audio() });
    const result = await service.importFromUrl({
      kind: 'song',
      url: `https://${SECRET_HOST}/s.mp3`,
    });
    expect(result.metadata).toMatchObject({
      artist: 'A',
      title: 'T',
      durationMs: 2000,
    });
  });

  it.each([
    ['plain http', `http://${SECRET_HOST}/a.mp3`, {}, 'scheme'],
    ['a private address', 'https://internal.example.com/a.mp3', {}, 'address'],
    ['an address literal', 'https://127.0.0.1/a.mp3', {}, 'address'],
    [
      'a name that does not resolve',
      'https://nowhere.example.com/a.mp3',
      {},
      'dns',
    ],
    [
      'credentials in the address',
      `https://u:p@${SECRET_HOST}/a.mp3`,
      {},
      'invalid_url',
    ],
    [
      'a redirect to a private host',
      `https://bounce.example.com/a.mp3`,
      {
        'bounce.example.com/a.mp3': {
          status: 302,
          headers: { location: 'https://internal.example.com/a.mp3' },
        },
      },
      'address',
    ],
    [
      'a page that is not audio',
      `https://${SECRET_HOST}/a.mp3`,
      { [`${SECRET_HOST}/a.mp3`]: audio('text/html') },
      'content_type',
    ],
    [
      'a body over the cap',
      `https://${SECRET_HOST}/a.mp3`,
      {
        [`${SECRET_HOST}/a.mp3`]: {
          ...audio(),
          headers: {
            'content-type': 'audio/mpeg',
            'content-length': String(MAX_IMPORT_BYTES + 1),
          },
        },
      },
      'too_large',
    ],
  ])(
    'refuses %s as a plain 400 and stores nothing',
    async (_why, url, script, reason) => {
      const { service, recorded } = build(script);
      const error = await service
        .importFromUrl({ kind: 'song', url })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(recorded).toEqual([['media_import', reason]]);
      expect(sendMock).not.toHaveBeenCalled();
      expect(JSON.stringify((error as Error).message)).not.toContain(
        'example.com',
      );
    },
  );

  it('answers 502 for an error status and 504 for a deadline', async () => {
    const down = build({ [`${SECRET_HOST}/a.mp3`]: { status: 503 } });
    await expect(
      down.service.importFromUrl({
        kind: 'song',
        url: `https://${SECRET_HOST}/a.mp3`,
      }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    const slow = build({
      [`${SECRET_HOST}/a.mp3`]: { status: 200, socketTimeout: true },
    });
    await expect(
      slow.service.importFromUrl({
        kind: 'song',
        url: `https://${SECRET_HOST}/a.mp3`,
      }),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('applies the upload checks to what was fetched', async () => {
    const { service } = build({
      [`${SECRET_HOST}/a.bin`]: audio('audio/opus'),
      [`${SECRET_HOST}/empty.mp3`]: audio('audio/mpeg', []),
    });
    await expect(
      service.importFromUrl({
        kind: 'song',
        url: `https://${SECRET_HOST}/a.bin`,
      }),
    ).rejects.toThrow('Unsupported audio file type');
    await expect(
      service.importFromUrl({
        kind: 'song',
        url: `https://${SECRET_HOST}/empty.mp3`,
      }),
    ).rejects.toThrow('Uploaded file is empty');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('names an address without a file name import, and never logs the address', async () => {
    const { service } = build({ [`${SECRET_HOST}/`]: audio() });
    const result = await service.importFromUrl({
      kind: 'background',
      url: `https://${SECRET_HOST}/`,
    });
    expect(result.key).toMatch(/^background\/.+\/import-.+\.mp3$/);
    const bad = await service
      .importFromUrl({ kind: 'background', url: 'https://%zz' })
      .catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(BadRequestException);
    for (const spy of logs)
      expect(JSON.stringify(spy.mock.calls)).not.toContain('example.com');
  });

  it('falls back to import when the file name cannot be decoded', async () => {
    const { service } = build({ [`${SECRET_HOST}/%E0%A4%A.mp3`]: audio() });
    const result = await service.importFromUrl({
      kind: 'song',
      url: `https://${SECRET_HOST}/%E0%A4%A.mp3`,
    });
    expect(result.key).toMatch(/^song\/.+\/import-.+\.mp3$/);
  });

  it('counts nothing when no metrics service is wired', async () => {
    const config = { get: jest.fn(() => 'bkt') };
    const service = new UploadsService(config as never);
    service.outboundDeps = scriptedTransport(names, {
      [`${SECRET_HOST}/a.mp3`]: audio(),
    });
    await expect(
      service.importFromUrl({
        kind: 'instant',
        url: `https://${SECRET_HOST}/a.mp3`,
      }),
    ).resolves.toMatchObject({ sizeBytes: 4 });
  });
});

describe('UploadsService.importFromUrl: artwork and stinger kinds', () => {
  let logs: jest.SpyInstance[];
  beforeEach(() => {
    sendMock.mockReset().mockResolvedValue({});
    logs = [
      jest.spyOn(console, 'error').mockImplementation(() => {}),
      jest.spyOn(console, 'warn').mockImplementation(() => {}),
      jest.spyOn(console, 'log').mockImplementation(() => {}),
    ];
  });
  afterEach(() => logs.forEach((spy) => spy.mockRestore()));

  const file = (type: string, extra: Record<string, string> = {}) => ({
    status: 200,
    headers: { 'content-type': type, ...extra },
    body: [Buffer.from('bytes')],
  });

  it('stores an image as an artwork upload and a webm as a stinger upload', async () => {
    const { service } = build({
      [`${SECRET_HOST}/Cover.png`]: file('image/png'),
      [`${SECRET_HOST}/hit.webm`]: file('video/webm'),
    });
    const art = await service.importFromUrl({
      kind: 'artwork',
      url: `https://${SECRET_HOST}/Cover.png`,
    });
    expect(art).toMatchObject({ contentType: 'image/png', sizeBytes: 5 });
    expect(art.key).toMatch(/^artwork\/\d{4}\/\d{2}\/\d{2}\/cover-.+\.png$/);
    expect(art.metadata).toBeUndefined();
    const stinger = await service.importFromUrl({
      kind: 'stinger',
      url: `https://${SECRET_HOST}/hit.webm`,
    });
    expect(stinger).toMatchObject({
      contentType: 'video/webm',
      sizeBytes: 5,
    });
    expect(stinger.key).toMatch(/^stinger\/.+\/hit-.+\.webm$/);
  });

  it.each([
    ['artwork', 'audio/mpeg', 'a.png'],
    ['artwork', 'image/svg+xml', 'a.png'],
    ['artwork', 'text/html', 'a.png'],
    ['stinger', 'video/mp4', 'a.webm'],
    ['stinger', 'audio/webm', 'a.webm'],
    ['song', 'image/png', 'a.mp3'],
    ['instant', 'video/webm', 'a.mp3'],
  ] as const)(
    'refuses a %s whose address answers %s, before reading the body',
    async (kind, type, name) => {
      const { service, recorded } = build({
        [`${SECRET_HOST}/${name}`]: file(type),
      });
      await expect(
        service.importFromUrl({
          kind,
          url: `https://${SECRET_HOST}/${name}`,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(recorded).toEqual([['media_import', 'content_type']]);
      expect(sendMock).not.toHaveBeenCalled();
    },
  );

  it('caps an artwork at 10 MiB and a stinger at 50 MiB, as the upload routes do', async () => {
    const { service, recorded } = build({
      [`${SECRET_HOST}/big.png`]: file('image/png', {
        'content-length': String(10 * 1024 * 1024 + 1),
      }),
      [`${SECRET_HOST}/big.webm`]: file('video/webm', {
        'content-length': String(50 * 1024 * 1024 + 1),
      }),
      [`${SECRET_HOST}/ok.webm`]: file('video/webm', {
        'content-length': String(10 * 1024 * 1024 + 1),
      }),
    });
    for (const [kind, name] of [
      ['artwork', 'big.png'],
      ['stinger', 'big.webm'],
    ] as const)
      await expect(
        service.importFromUrl({
          kind,
          url: `https://${SECRET_HOST}/${name}`,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    expect(recorded).toEqual([
      ['media_import', 'too_large'],
      ['media_import', 'too_large'],
    ]);
    // 10 MiB + 1 is within a stinger's cap: the fetch lets it through.
    await expect(
      service.importFromUrl({
        kind: 'stinger',
        url: `https://${SECRET_HOST}/ok.webm`,
      }),
    ).resolves.toMatchObject({ contentType: 'video/webm' });
  });

  it('keeps the type and the extension of the image fetched', async () => {
    const { service } = build({
      [`${SECRET_HOST}/odd.jpg`]: file('image/jpeg'),
    });
    await expect(
      service.importFromUrl({
        kind: 'artwork',
        url: `https://${SECRET_HOST}/odd.jpg`,
      }),
    ).resolves.toMatchObject({ contentType: 'image/jpeg' });
  });
});
