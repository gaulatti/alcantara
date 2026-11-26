import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { MediaAssetKind, MediaAssetType } from '@prisma/client';
import { AlanaClient } from '../src/broadcast-destinations/alana.client';
import { FillerBindingService } from '../src/filler/filler-binding.service';
import { FillerService } from '../src/filler/filler.service';
import { ManagedMetricsService } from '../src/observability/managed-metrics.service';
import { PrismaService } from '../src/prisma.service';
import { PalazzoMachineClient } from '../src/radio/palazzo-machine.client';
import { RadioMetricsService } from '../src/radio/radio-metrics.service';

// gaulatti/alcantara#126 against real PostgreSQL with the committed
// migrations applied: existing programs are untouched, concurrent
// preparations keep the newest pending version, state survives a restart,
// and Start binding moves the pointers atomically.

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const BUCKET = 'media-test';
const media = (name: string) => `https://${BUCKET}.s3.amazonaws.com/${name}`;

describeWithDatabase('program filler persistence (PostgreSQL e2e)', () => {
  let prisma: PrismaService;
  let palazzoUrl: string;
  const suffix = randomUUID();
  const legacyProgram = `e2e-legacy-${suffix}`;
  const radioProgram = `e2e-radio-${suffix}`;
  const assetIds = Array.from(
    { length: 10 },
    (_, i) => `song:e2e-${suffix}-${i}`,
  );
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const version = decodeURIComponent((request.url ?? '').split('/').pop()!);
      // Answer out of order, so later requests can finish first.
      setTimeout(
        () => {
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({ version, ready: true, status: 'ready' }),
          );
        },
        Math.floor(Math.random() * 40),
      );
    });
  });

  const service = (client: PrismaService) => {
    const config = new ConfigService({
      NODE_ENV: 'test',
      MEDIA_S3_BUCKET: BUCKET,
      AWS_REGION: 'us-east-1',
      ALANA_CONTROL_URL: palazzoUrl,
      ALANA_CONTROL_TOKEN: 'fictional-alana-control-token',
      PALAZZO_ALLOWED_URLS: palazzoUrl,
    });
    const metrics = new ManagedMetricsService();
    return new FillerService(
      client,
      new AlanaClient(config, metrics),
      new PalazzoMachineClient(config, new RadioMetricsService()),
      config,
      metrics,
      { teamId: 0 } as never,
    );
  };

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.pathname !== '/alcantara_ci'
    ) {
      throw new Error('Filler persistence test requires local CI PostgreSQL');
    }
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    palazzoUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.programState.create({
      data: { programId: legacyProgram, type: 'both' },
    });
    const radio = await prisma.programState.create({
      data: { programId: radioProgram, type: 'radio' },
    });
    await prisma.radioSettings.create({
      data: { programStateId: radio.id, palazzoUrl },
    });
    await prisma.mediaAsset.createMany({
      data: assetIds.map((id, index) => ({
        id,
        kind: MediaAssetKind.SONG,
        mediaType: MediaAssetType.AUDIO,
        name: `E2E song ${index}`,
        sourceUrl: media(`e2e-${index}.mp3`),
      })),
    });
    const realFetch = globalThis.fetch;
    jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const target = input instanceof Request ? input.url : input.toString();
      return target.startsWith(`https://${BUCKET}.`)
        ? Promise.resolve(new Response(`bytes of ${target}`))
        : realFetch(input, init);
    });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (prisma) {
      const programs = [legacyProgram, radioProgram];
      await prisma.fillerLeg.deleteMany({
        where: { programId: { in: programs } },
      });
      await prisma.fillerVersion.deleteMany({
        where: { programId: { in: programs } },
      });
      await prisma.mediaAsset.deleteMany({ where: { id: { in: assetIds } } });
      await prisma.programState.deleteMany({
        where: { programId: { in: programs } },
      });
      await prisma.$disconnect();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('leaves an existing program exactly as it was', async () => {
    const before = await prisma.programState.findUnique({
      where: { programId: legacyProgram },
    });
    await expect(service(prisma).getState(legacyProgram)).resolves.toEqual({
      programId: legacyProgram,
      legs: {
        television: { pending: null, active: null },
        radio: { pending: null, active: null },
      },
    });
    expect(
      await prisma.fillerLeg.count({ where: { programId: legacyProgram } }),
    ).toBe(0);
    expect(
      await prisma.programState.findUnique({
        where: { programId: legacyProgram },
      }),
    ).toEqual(before);
  });

  it('keeps the newest pending version under concurrent preparations', async () => {
    const fillers = service(prisma);
    const results = await Promise.all(
      assetIds.map((id) =>
        fillers.prepareRadio(radioProgram, { assetIds: [id] }, 'operator-e2e'),
      ),
    );
    expect(results).toHaveLength(assetIds.length);
    const versions = await prisma.fillerVersion.findMany({
      where: { programId: radioProgram, leg: 'radio' },
      orderBy: { createdAt: 'asc' },
    });
    expect(versions.map((version) => version.status)).toEqual(
      assetIds.map(() => 'ready'),
    );
    const legs = await prisma.fillerLeg.findMany({
      where: { programId: radioProgram },
    });
    expect(legs).toHaveLength(1);
    const newest = versions.reduce((latest, version) =>
      version.createdAt > latest.createdAt ? version : latest,
    );
    const pending = versions.find(
      (version) => version.id === legs[0].pendingVersionId,
    )!;
    expect(pending.createdAt.getTime()).toBe(newest.createdAt.getTime());
  });

  it('reads the same state after a restart', async () => {
    const before = await service(prisma).getState(radioProgram);
    const restarted = new PrismaService();
    await restarted.$connect();
    try {
      expect(
        JSON.parse(
          JSON.stringify(await service(restarted).getState(radioProgram)),
        ),
      ).toEqual(JSON.parse(JSON.stringify(before)));
    } finally {
      await restarted.$disconnect();
    }
  });

  it('moves the television pointers atomically when concurrent Starts confirm the same version', async () => {
    const version = await prisma.fillerVersion.create({
      data: {
        id: `filler-tv-e2e-${suffix}`,
        programId: legacyProgram,
        leg: 'television',
        checksum: 'a'.repeat(64),
        config: { sources: [], mode: 'loop', profileChecksum: 'b'.repeat(64) },
        status: 'ready',
        createdBy: 'operator-e2e',
      },
    });
    await prisma.fillerLeg.create({
      data: {
        programId: legacyProgram,
        leg: 'television',
        pendingVersionId: version.id,
      },
    });
    const binding = new FillerBindingService(
      prisma,
      new ManagedMetricsService(),
    );
    const status = {
      activeFiller: {
        version: version.id,
        status: 'ready',
        ready: true,
        profileChecksum: 'b'.repeat(64),
      },
    } as never;
    await Promise.all(
      [1, 2, 3].map(() =>
        binding.confirmTelevisionStart(legacyProgram, version, status),
      ),
    );
    expect(
      await prisma.fillerLeg.findUnique({
        where: {
          programId_leg: { programId: legacyProgram, leg: 'television' },
        },
      }),
    ).toMatchObject({
      pendingVersionId: null,
      activeVersionId: version.id,
    });
  });
});
