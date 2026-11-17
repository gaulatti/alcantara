/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- the in-memory store and parsed HTTP bodies are untyped */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  AlanaClient,
  liveProfileChecksum,
} from '../broadcast-destinations/alana.client';
import type { TelevisionLiveProfile } from '../broadcast-destinations/broadcast-destinations.types';
import { PalazzoMachineClient } from '../radio/palazzo-machine.client';
import { RadioMetricsService } from '../radio/radio-metrics.service';
import {
  FillerService,
  executorSourceId,
  fillerChecksum,
  programLegs,
} from './filler.service';

// gaulatti/alcantara#126: preparing immutable television and radio filler
// versions against Alana and Palazzo served by a real local HTTP server, with
// managed-bucket media read through fetch.

const BUCKET = 'media-test';
const PROFILE: TelevisionLiveProfile = {
  width: 1920,
  height: 1080,
  fps: 30,
  videoBitrate: '6000k',
  audioRate: 44100,
  audioChannels: 2,
  audioBitrate: '160k',
  gop: 60,
  loopSeconds: 10,
};
const PROFILE_CHECKSUM = liveProfileChecksum(PROFILE);
const media = (name: string) => `https://${BUCKET}.s3.amazonaws.com/${name}`;
const BODIES: Record<string, string> = {
  [media('slate.png')]: 'slate image bytes',
  [media('loop.webm')]: 'loop video bytes',
  [media('a.mp3')]: 'audio a',
  [media('b.mp3')]: 'audio b',
};
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

type Recorded = {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: any;
};
const recorded: Recorded[] = [];
/** The next response for a path prefix; the default answers per the contract. */
const overrides = new Map<string, { status: number; body: unknown }>();
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const text = Buffer.concat(chunks).toString();
    const body = text ? JSON.parse(text) : undefined;
    const url = request.url ?? '/';
    recorded.push({
      method: request.method ?? 'GET',
      url,
      headers: request.headers,
      body,
    });
    const override = [...overrides.entries()].find(([prefix]) =>
      url.startsWith(prefix),
    );
    const reply = (status: number, payload: unknown) => {
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(payload));
    };
    if (override) {
      overrides.delete(override[0]);
      return reply(override[1].status, override[1].body);
    }
    const profile = /^\/v1\/programs\/([^/]+)\/live-profile$/.exec(url);
    if (profile) {
      return reply(200, {
        contractVersion: 1,
        programId: decodeURIComponent(profile[1]),
        profile: PROFILE,
        checksum: PROFILE_CHECKSUM,
      });
    }
    const alanaFiller = /^\/v1\/programs\/[^/]+\/fillers\/([^/]+)$/.exec(url);
    if (alanaFiller && body?.source) {
      return reply(200, {
        version: decodeURIComponent(alanaFiller[1]),
        status: 'ready',
        ready: true,
        sourceId: body.source.id,
        sourceSha256: body.source.sha256,
        artifactSha256: 'a'.repeat(64),
        profile: body.profile,
        profileChecksum: liveProfileChecksum(body.profile),
      });
    }
    if (alanaFiller) {
      return reply(200, {
        version: decodeURIComponent(alanaFiller[1]),
        ready: true,
        status: 'ready',
      });
    }
    reply(404, {});
  });
});
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const realFetch = globalThis.fetch;
beforeEach(() => {
  recorded.length = 0;
  overrides.clear();
  // Managed-bucket media is served from memory; machine calls reach the local server.
  jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url in BODIES) return Promise.resolve(new Response(BODIES[url]));
    return realFetch(input, init);
  });
});
afterEach(() => jest.restoreAllMocks());

/** An in-memory store with the Prisma calls FillerService makes. */
function store(programs: Record<string, string>) {
  const versions = new Map<string, any>();
  const legs = new Map<string, any>();
  let clock = Date.parse('2026-11-17T12:00:00Z');
  const assets = new Map<string, any>([
    [
      'slate',
      {
        id: 'slate',
        enabled: true,
        mediaType: 'IMAGE',
        sourceUrl: media('slate.png'),
      },
    ],
    [
      'loop',
      {
        id: 'loop',
        enabled: true,
        mediaType: 'VIDEO',
        sourceUrl: media('loop.webm'),
      },
    ],
    [
      'song-a',
      {
        id: 'song-a',
        enabled: true,
        mediaType: 'AUDIO',
        sourceUrl: media('a.mp3'),
      },
    ],
    [
      'song-b',
      {
        id: 'song-b',
        enabled: true,
        mediaType: 'AUDIO',
        sourceUrl: media('b.mp3'),
      },
    ],
    [
      'off',
      {
        id: 'off',
        enabled: false,
        mediaType: 'IMAGE',
        sourceUrl: media('slate.png'),
      },
    ],
    [
      'untyped',
      {
        id: 'untyped',
        enabled: true,
        mediaType: null,
        sourceUrl: media('slate.png'),
      },
    ],
  ]);
  const key = (programId: string, leg: string) => `${programId}/${leg}`;
  const prisma: any = {
    programState: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(
          programs[where.programId]
            ? { programId: where.programId, type: programs[where.programId] }
            : null,
        ),
      ),
    },
    radioSettings: {
      findFirst: jest.fn(({ where }: any) =>
        Promise.resolve(
          programs[where.programState.programId] === 'tv'
            ? null
            : { palazzoUrl: baseUrl },
        ),
      ),
    },
    mediaAsset: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(assets.get(where.id) ?? null),
      ),
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          where.id.in.map((id: string) => assets.get(id)).filter(Boolean),
        ),
      ),
    },
    fillerVersion: {
      create: jest.fn(({ data }: any) => {
        const row = {
          reason: null,
          preparedAt: null,
          ...data,
          createdAt: new Date((clock += 1000)),
        };
        versions.set(row.id, row);
        return Promise.resolve(row);
      }),
      update: jest.fn(({ where, data }: any) => {
        Object.assign(versions.get(where.id), data);
        return Promise.resolve(versions.get(where.id));
      }),
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(versions.get(where.id) ?? null),
      ),
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          where.id
            ? where.id.in.map((id: string) => versions.get(id)).filter(Boolean)
            : [...versions.values()].filter(
                (version) =>
                  version.programId === where.programId &&
                  version.leg === where.leg &&
                  version.createdAt <= where.createdAt.lte,
              ),
        ),
      ),
    },
    fillerLeg: {
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          [...legs.values()].filter((leg) => leg.programId === where.programId),
        ),
      ),
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(
          legs.get(
            key(where.programId_leg.programId, where.programId_leg.leg),
          ) ?? null,
        ),
      ),
      createMany: jest.fn(({ data, skipDuplicates }: any) => {
        expect(skipDuplicates).toBe(true);
        let count = 0;
        for (const row of data) {
          const id = key(row.programId, row.leg);
          if (legs.has(id)) continue;
          legs.set(id, {
            activeVersionId: null,
            pendingVersionId: null,
            ...row,
          });
          count += 1;
        }
        return Promise.resolve({ count });
      }),
      updateMany: jest.fn(({ where, data }: any) => {
        const leg = legs.get(key(where.programId, where.leg));
        const matches =
          leg &&
          where.OR.some((condition: any) =>
            condition.pendingVersionId === null
              ? leg.pendingVersionId === null
              : condition.pendingVersionId.in.includes(leg.pendingVersionId),
          );
        if (matches) Object.assign(leg, data);
        return Promise.resolve({ count: matches ? 1 : 0 });
      }),
    },
    $transaction: jest.fn((run: (tx: unknown) => Promise<unknown>) =>
      run(prisma),
    ),
  };
  return { prisma, versions, legs, assets };
}

function build(
  programs: Record<string, string> = {
    'tv-1': 'tv',
    'radio-1': 'radio',
    'both-1': 'both',
  },
) {
  const config = new ConfigService({
    NODE_ENV: 'test',
    MEDIA_S3_BUCKET: BUCKET,
    AWS_REGION: 'us-east-1',
    ALANA_CONTROL_URL: baseUrl,
    ALANA_CONTROL_TOKEN: 'fictional-alana-control-token',
    PALAZZO_ALLOWED_URLS: baseUrl,
  });
  const metrics = new ManagedMetricsService();
  const db = store(programs);
  const service = new FillerService(
    db.prisma,
    new AlanaClient(config, metrics),
    new PalazzoMachineClient(config, new RadioMetricsService()),
    config,
    metrics,
  );
  const samples = async (name: string) =>
    (await metrics.render(''))
      .split('\n')
      .filter((line) => line.startsWith(`${name}{`) && !line.endsWith(' 0'));
  return { service, metrics, samples, ...db };
}

describe('program filler state', () => {
  it('lists the legs of each program type with nothing configured', async () => {
    const { service } = build();
    await expect(service.getState('tv-1')).resolves.toEqual({
      programId: 'tv-1',
      legs: { television: { pending: null, active: null } },
    });
    await expect(service.getState('radio-1')).resolves.toMatchObject({
      legs: { radio: { pending: null, active: null } },
    });
    expect(Object.keys((await service.getState('both-1')).legs)).toEqual([
      'television',
      'radio',
    ]);
    expect(programLegs('tv')).toEqual(['television']);
    await expect(service.getState('missing')).rejects.toThrow(
      'Program not found',
    );
  });

  it('gives executors a source id they accept for every managed asset id', () => {
    // Alana, Croccante and Palazzo accept only this identifier shape; managed
    // asset ids carry a `kind:` prefix.
    const EXECUTOR_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
    for (const assetId of ['song-cover:12', 'media:7', 'slate']) {
      expect(executorSourceId(assetId)).toMatch(EXECUTOR_IDENTIFIER);
    }
    expect(executorSourceId('media:7')).toBe(executorSourceId('media:7'));
    expect(executorSourceId('media:7')).not.toBe(executorSourceId('media:8'));
  });

  it('derives a version checksum from its program, leg and configuration', () => {
    const config = {
      sources: [{ assetId: 'slate', sha256: sha('x') }],
      mode: 'loop' as const,
    };
    expect(fillerChecksum('tv-1', 'television', config)).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(fillerChecksum('tv-1', 'television', config)).not.toBe(
      fillerChecksum('both-1', 'television', config),
    );
  });
});

describe('television filler preparation', () => {
  it('prepares an image with the effective live profile and makes it the pending version', async () => {
    const { service, samples } = build();
    const state = await service.prepareTelevision(
      'tv-1',
      { assetId: 'slate' },
      'operator-1',
    );
    const pending = state.legs.television.pending!;
    expect(pending).toMatchObject({
      status: 'ready',
      reason: null,
      config: {
        sources: [{ assetId: 'slate', sha256: sha('slate image bytes') }],
        mode: 'loop',
        profileChecksum: PROFILE_CHECKSUM,
      },
    });
    expect(pending.version).toMatch(/^filler-tv-/);
    expect(pending.preparedAt).not.toBeNull();
    expect(state.legs.television.active).toBeNull();
    const put = recorded.find((request) => request.method === 'PUT')!;
    expect(put.url).toBe(`/v1/programs/tv-1/fillers/${pending.version}`);
    expect(put.headers['idempotency-key']).toBe(pending.version);
    expect(put.headers.authorization).toBe(
      `Bearer ${'fictional-alana-control-token'}`,
    );
    expect(put.body).toEqual({
      commandId: pending.version,
      source: {
        id: executorSourceId('slate'),
        sha256: sha('slate image bytes'),
        downloadUrl: media('slate.png'),
      },
      profile: PROFILE,
    });
    // The stored version keeps identity only, never the download URL.
    expect(JSON.stringify(state)).not.toContain('s3.amazonaws.com');
    expect(await samples('alcantara_filler_preparations_total')).toEqual([
      'alcantara_filler_preparations_total{leg="television",result="ready"} 1',
    ]);
  });

  it('accepts a video source and keeps the previous ready version until a new one is ready', async () => {
    const { service } = build();
    const first = (
      await service.prepareTelevision(
        'tv-1',
        { assetId: 'slate' },
        'operator-1',
      )
    ).legs.television.pending!;
    overrides.set('/v1/programs/tv-1/fillers/', {
      status: 500,
      body: { error: 'croccante-unavailable' },
    });
    await expect(
      service.prepareTelevision('tv-1', { assetId: 'loop' }, 'operator-1'),
    ).rejects.toThrow('Alana could not prepare the television filler');
    expect(
      (await service.getState('tv-1')).legs.television.pending!.version,
    ).toBe(first.version);
    const second = (
      await service.prepareTelevision('tv-1', { assetId: 'loop' }, 'operator-1')
    ).legs.television.pending!;
    expect(second.version).not.toBe(first.version);
    expect(second.config.sources[0]).toEqual({
      assetId: 'loop',
      sha256: sha('loop video bytes'),
    });
  });

  it('refuses preparation when Alana publishes no live profile, and never guesses one', async () => {
    const { service, versions, samples } = build();
    overrides.set('/v1/programs/tv-1/live-profile', { status: 404, body: {} });
    await expect(
      service.prepareTelevision('tv-1', { assetId: 'slate' }, 'operator-1'),
    ).rejects.toThrow('television live profile unavailable');
    expect(recorded.map((request) => request.method)).toEqual(['GET']);
    expect(versions.size).toBe(0);
    expect(await samples('alcantara_filler_preparations_total')).toEqual([
      'alcantara_filler_preparations_total{leg="television",result="profile-unavailable"} 1',
    ]);
  });

  it.each([
    ['an unreadable live profile', { status: 503, body: {} }],
    [
      'an incomplete live profile',
      {
        status: 200,
        body: {
          contractVersion: 1,
          programId: 'tv-1',
          profile: { width: 1 },
          checksum: 'x',
        },
      },
    ],
    [
      'a profile for another program',
      {
        status: 200,
        body: {
          contractVersion: 1,
          programId: 'other',
          profile: PROFILE,
          checksum: PROFILE_CHECKSUM,
        },
      },
    ],
    [
      'a profile whose checksum does not match',
      {
        status: 200,
        body: {
          contractVersion: 1,
          programId: 'tv-1',
          profile: PROFILE,
          checksum: 'f'.repeat(64),
        },
      },
    ],
    [
      'a newer profile contract',
      {
        status: 200,
        body: {
          contractVersion: 2,
          programId: 'tv-1',
          profile: PROFILE,
          checksum: PROFILE_CHECKSUM,
        },
      },
    ],
    [
      'a malformed bitrate',
      {
        status: 200,
        body: {
          contractVersion: 1,
          programId: 'tv-1',
          profile: { ...PROFILE, videoBitrate: '6M' },
          checksum: PROFILE_CHECKSUM,
        },
      },
    ],
    [
      'a non-integer dimension',
      {
        status: 200,
        body: {
          contractVersion: 1,
          programId: 'tv-1',
          profile: { ...PROFILE, fps: 29.97 },
          checksum: PROFILE_CHECKSUM,
        },
      },
    ],
    ['a non-object body', { status: 200, body: ['profile'] }],
  ])('fails closed on %s', async (_name, reply) => {
    const { service, versions, samples } = build();
    overrides.set('/v1/programs/tv-1/live-profile', reply);
    await expect(
      service.prepareTelevision('tv-1', { assetId: 'slate' }, 'operator-1'),
    ).rejects.toThrow('Alana live profile could not be read');
    expect(versions.size).toBe(0);
    expect(await samples('alcantara_filler_preparations_total')).toEqual([
      'alcantara_filler_preparations_total{leg="television",result="unavailable"} 1',
    ]);
  });

  it.each([
    ['a different version', (body: any) => ({ ...body, version: 'other' })],
    [
      'a not-ready status',
      (body: any) => ({ ...body, ready: false, status: 'failed' }),
    ],
    [
      'a ready flag without the ready status',
      (body: any) => ({ ...body, status: 'preparing' }),
    ],
    ['a different source', (body: any) => ({ ...body, sourceId: 'loop' })],
    [
      'a different source checksum',
      (body: any) => ({ ...body, sourceSha256: 'b'.repeat(64) }),
    ],
    [
      'no profile checksum, as from Alana before #29',
      (body: any) => ({ ...body, profileChecksum: undefined }),
    ],
    [
      'a different profile checksum',
      (body: any) => ({ ...body, profileChecksum: 'c'.repeat(64) }),
    ],
    ['no acknowledgement object', () => 'ok'],
  ])('records the version failed on %s', async (_name, change) => {
    const { service, versions, legs } = build();
    const put = jest.fn();
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url in BODIES) return new Response(BODIES[url]);
      const response = await realFetch(input, init);
      if (init?.method !== 'PUT') return response;
      put();
      return new Response(JSON.stringify(change(await response.json())), {
        status: 200,
      });
    });
    await expect(
      service.prepareTelevision('tv-1', { assetId: 'slate' }, 'operator-1'),
    ).rejects.toThrow('Alana did not acknowledge the exact television filler');
    expect(put).toHaveBeenCalledTimes(1);
    expect(
      [...versions.values()].map((version) => [version.status, version.reason]),
    ).toEqual([['failed', 'acknowledgement-mismatch']]);
    expect(legs.size).toBe(0);
  });

  it('reports a conflicting version that Alana refused', async () => {
    const { service, versions } = build();
    overrides.set('/v1/programs/tv-1/fillers/', {
      status: 409,
      body: { error: 'conflict' },
    });
    await expect(
      service.prepareTelevision('tv-1', { assetId: 'slate' }, 'operator-1'),
    ).rejects.toThrow('Alana refused a conflicting filler version');
    expect([...versions.values()][0]).toMatchObject({
      status: 'failed',
      reason: 'executor-rejected',
    });
  });

  it.each([
    ['a missing asset id', {}],
    ['a malformed asset id', { assetId: '../slate' }],
  ])('rejects %s', async (_name, input) => {
    const { service } = build();
    await expect(
      service.prepareTelevision('tv-1', input, 'operator-1'),
    ).rejects.toThrow('assetId must be a media asset id');
  });

  it.each(['missing', 'off', 'song-a', 'untyped'])(
    'rejects the %s asset as a television source',
    async (assetId) => {
      const { service } = build();
      await expect(
        service.prepareTelevision('tv-1', { assetId }, 'operator-1'),
      ).rejects.toThrow(
        'television filler must be an enabled image or video media asset',
      );
      expect(recorded).toEqual([]);
    },
  );

  it('rejects a program without a television leg, and an unknown program', async () => {
    const { service } = build();
    await expect(
      service.prepareTelevision('radio-1', { assetId: 'slate' }, 'operator-1'),
    ).rejects.toThrow('This program has no television leg');
    await expect(
      service.prepareTelevision('missing', { assetId: 'slate' }, 'operator-1'),
    ).rejects.toThrow('Program not found');
  });
});

describe('radio filler preparation', () => {
  it('prepares an ordered playlist on Palazzo', async () => {
    const { service } = build();
    const pending = (
      await service.prepareRadio(
        'radio-1',
        { assetIds: ['song-b', 'song-a'] },
        'operator-1',
      )
    ).legs.radio.pending!;
    expect(pending.version).toMatch(/^filler-radio-/);
    expect(pending.config).toEqual({
      sources: [
        { assetId: 'song-b', sha256: sha('audio b') },
        { assetId: 'song-a', sha256: sha('audio a') },
      ],
      mode: 'ordered',
    });
    const put = recorded.find((request) => request.method === 'PUT')!;
    expect(put.url).toBe(`/v1/programs/radio-1/fillers/${pending.version}`);
    expect(put.body).toEqual({
      commandId: pending.version,
      mode: 'ordered',
      assets: [
        {
          id: executorSourceId('song-b'),
          sha256: sha('audio b'),
          downloadUrl: media('b.mp3'),
        },
        {
          id: executorSourceId('song-a'),
          sha256: sha('audio a'),
          downloadUrl: media('a.mp3'),
        },
      ],
    });
  });

  it('prepares a shuffled playlist with its seed, independently of the television leg', async () => {
    const { service } = build();
    await service.prepareTelevision(
      'both-1',
      { assetId: 'slate' },
      'operator-1',
    );
    const state = await service.prepareRadio(
      'both-1',
      {
        assetIds: ['song-a', 'song-b'],
        mode: 'shuffle',
        shuffleSeed: 'rotation-7',
      },
      'operator-1',
    );
    expect(state.legs.radio.pending!.config).toMatchObject({
      mode: 'shuffle',
      shuffleSeed: 'rotation-7',
    });
    expect(state.legs.television.pending!.status).toBe('ready');
    expect(
      recorded.filter((request) => request.method === 'PUT').at(-1)!.body,
    ).toMatchObject({
      mode: 'shuffle',
      shuffleSeed: 'rotation-7',
    });
  });

  it('keeps the newer pending version when an older preparation finishes last', async () => {
    const { service, versions, legs } = build();
    const first = (
      await service.prepareRadio(
        'radio-1',
        { assetIds: ['song-a'] },
        'operator-1',
      )
    ).legs.radio.pending!;
    const second = (
      await service.prepareRadio(
        'radio-1',
        { assetIds: ['song-b'] },
        'operator-1',
      )
    ).legs.radio.pending!;
    expect(legs.get('radio-1/radio').pendingVersionId).toBe(second.version);
    // Replaying the older version's completion does not move the pointer back.
    const older = versions.get(first.version);
    await (service as any).finishVersion(older, 'ready');
    expect(legs.get('radio-1/radio').pendingVersionId).toBe(second.version);
  });

  it('records a failed version and keeps the previous one when Palazzo refuses', async () => {
    const { service, versions, samples } = build();
    const first = (
      await service.prepareRadio(
        'radio-1',
        { assetIds: ['song-a'] },
        'operator-1',
      )
    ).legs.radio.pending!;
    overrides.set('/v1/programs/radio-1/fillers/', { status: 422, body: {} });
    await expect(
      service.prepareRadio('radio-1', { assetIds: ['song-b'] }, 'operator-1'),
    ).rejects.toThrow('Palazzo could not prepare the radio filler');
    expect(
      (await service.getState('radio-1')).legs.radio.pending!.version,
    ).toBe(first.version);
    expect([...versions.values()].map((version) => version.status)).toEqual([
      'ready',
      'failed',
    ]);
    expect(await samples('alcantara_filler_preparations_total')).toEqual([
      'alcantara_filler_preparations_total{leg="radio",result="ready"} 1',
      'alcantara_filler_preparations_total{leg="radio",result="failed"} 1',
    ]);
  });

  it.each([
    ['no list', {}],
    ['an empty list', { assetIds: [] }],
    [
      'too many sources',
      { assetIds: Array.from({ length: 101 }, (_, i) => `song-${i}`) },
    ],
    ['duplicates', { assetIds: ['song-a', 'song-a'] }],
    ['a malformed id', { assetIds: ['song a'] }],
    ['a non-string id', { assetIds: [7] }],
  ])('rejects %s', async (_name, input) => {
    const { service } = build();
    await expect(
      service.prepareRadio('radio-1', input, 'operator-1'),
    ).rejects.toThrow('select 1 to 100 distinct audio media assets');
  });

  it.each([
    [{ mode: 'random' }, 'mode must be ordered or shuffle'],
    [
      { mode: 'ordered', shuffleSeed: 'x' },
      'shuffleSeed applies only to shuffle',
    ],
    [{ mode: 'shuffle' }, 'shuffle requires a bounded shuffleSeed'],
    [
      { mode: 'shuffle', shuffleSeed: 'seed with spaces' },
      'shuffle requires a bounded shuffleSeed',
    ],
  ])('rejects the order %j', async (order, message) => {
    const { service } = build();
    await expect(
      service.prepareRadio(
        'radio-1',
        { assetIds: ['song-a'], ...order },
        'operator-1',
      ),
    ).rejects.toThrow(message);
  });

  it('rejects non-audio or disabled sources and missing radio settings', async () => {
    const { service, prisma } = build();
    await expect(
      service.prepareRadio(
        'radio-1',
        { assetIds: ['song-a', 'slate'] },
        'operator-1',
      ),
    ).rejects.toThrow(
      'every radio filler source must be an enabled audio media asset',
    );
    await expect(
      service.prepareRadio('radio-1', { assetIds: ['missing'] }, 'operator-1'),
    ).rejects.toThrow(
      'every radio filler source must be an enabled audio media asset',
    );
    prisma.radioSettings.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.prepareRadio('radio-1', { assetIds: ['song-a'] }, 'operator-1'),
    ).rejects.toThrow('Radio settings are unavailable');
    await expect(
      service.prepareRadio('tv-1', { assetIds: ['song-a'] }, 'operator-1'),
    ).rejects.toThrow('This program has no radio leg');
  });
});
