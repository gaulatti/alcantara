import { randomUUID } from 'node:crypto';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import {
  MEDIA_ASSET_TEAM_GAUGE_INTERVAL_MS,
  MediaAssetTeamGaugeService,
} from './media-asset-team-gauge.service';

const GAUGE = 'alcantara_media_assets_without_team';

const scraped = async (metrics: ManagedMetricsService) => {
  const line = (await metrics.render(''))
    .split('\n')
    .find((row) => row.startsWith(`${GAUGE} `));
  return line === undefined ? undefined : Number(line.split(' ')[1]);
};

function build(count = 3) {
  const prisma = { mediaAsset: { count: jest.fn().mockResolvedValue(count) } };
  const metrics = new ManagedMetricsService();
  const service = new MediaAssetTeamGaugeService(prisma as never, metrics);
  return { prisma, metrics, service };
}

describe('media assets without a team', () => {
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.ALCANTARA_DEPLOY_CANDIDATE;
  });

  it('publishes nothing before the first read, then at start and on each interval', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const { prisma, metrics, service } = build();
    await expect(scraped(metrics)).resolves.toBeUndefined();
    service.onApplicationBootstrap();
    await service.whenStarted();
    await expect(scraped(metrics)).resolves.toBe(3);

    prisma.mediaAsset.count.mockResolvedValue(0);
    await jest.advanceTimersByTimeAsync(MEDIA_ASSET_TEAM_GAUGE_INTERVAL_MS);
    await expect(scraped(metrics)).resolves.toBe(0);

    service.onModuleDestroy();
    service.onModuleDestroy();
    prisma.mediaAsset.count.mockClear();
    await jest.advanceTimersByTimeAsync(MEDIA_ASSET_TEAM_GAUGE_INTERVAL_MS);
    expect(prisma.mediaAsset.count).not.toHaveBeenCalled();
  });

  it('withdraws the count when a read fails', async () => {
    const { prisma, metrics, service } = build();
    await service.refresh();
    prisma.mediaAsset.count.mockRejectedValueOnce(new Error('secret host'));
    await service.refresh();
    await expect(scraped(metrics)).resolves.toBeUndefined();
    await service.refresh();
    await expect(scraped(metrics)).resolves.toBe(3);
  });

  it('reads nothing on a deploy candidate', async () => {
    process.env.ALCANTARA_DEPLOY_CANDIDATE = '1';
    const { prisma, service } = build();
    service.onApplicationBootstrap();
    await service.whenStarted();
    expect(prisma.mediaAsset.count).not.toHaveBeenCalled();
  });

  it('records Object for constructor types whose tokens are unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({}));
      jest.doMock('../playout/playout-lease.service', () => ({ ...jest.requireActual('../playout/playout-lease.service'), PlayoutLease: undefined }));
      jest.doMock('../observability/managed-metrics.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const loaded = require('./media-asset-team-gauge.service') as {
        MediaAssetTeamGaugeService: object;
      };
      expect(
        Reflect.getMetadata(
          'design:paramtypes',
          loaded.MediaAssetTeamGaugeService,
        ),
      ).toEqual([Object, Object, Object]);
    });
    jest.dontMock('../prisma.service');
    jest.dontMock('../observability/managed-metrics.service');
  });
});

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

describe('media assets without a team, against Postgres', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  // The database is shared with other specs, so this counts what its own rows add inside one transaction
  // that no other session sees and that is rolled back.
  it('counts assets with no team or team 0, and no other', async () => {
    const read = async (db: PrismaService) => {
      const metrics = new ManagedMetricsService();
      await new MediaAssetTeamGaugeService(db, metrics).refresh();
      return (await scraped(metrics))!;
    };
    const rollback = new Error('rollback');
    await expect(
      prisma.$transaction(
        async (tx) => {
          const before = await read(tx as unknown as PrismaService);
          for (const teamId of [null, 0, 7]) {
            await tx.mediaAsset.create({
              data: {
                id: `media:${randomUUID()}`,
                mediaType: 'AUDIO',
                name: 'gauge',
                sourceUrl: 'https://media.test/gauge.mp3',
                teamId,
              },
            });
          }
          const after = await read(tx as unknown as PrismaService);
          expect(after - before).toBe(2);
          throw rollback;
        },
        { isolationLevel: 'RepeatableRead' },
      ),
    ).rejects.toBe(rollback);
  });
});
