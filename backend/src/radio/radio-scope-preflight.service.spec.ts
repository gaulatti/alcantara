import { randomUUID } from 'node:crypto';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import {
  RADIO_SCOPE_PREFLIGHT_INTERVAL_MS,
  RadioScopePreflightService,
} from './radio-scope-preflight.service';

const PROGRAMS = 'alcantara_radio_programs_without_team';
const SONGS = 'alcantara_library_songs_without_team';

const scraped = async (metrics: ManagedMetricsService, name: string) => {
  const line = (await metrics.render(''))
    .split('\n')
    .find((row) => row.startsWith(`${name} `));
  return line === undefined ? undefined : Number(line.split(' ')[1]);
};

function build(radio = 3, owned = 1, songs = 4) {
  const prisma = {
    programState: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          Array.from({ length: radio }, (_, i) => ({ programId: `p${i}` })),
        ),
    },
    program: { count: jest.fn().mockResolvedValue(owned) },
    song: { count: jest.fn().mockResolvedValue(songs) },
  };
  const metrics = new ManagedMetricsService();
  const service = new RadioScopePreflightService(prisma as never, metrics);
  return { prisma, metrics, service };
}

describe('radio scope preflight', () => {
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.ALCANTARA_DEPLOY_CANDIDATE;
  });

  it('publishes nothing before the first read', async () => {
    const { metrics } = build();
    await expect(scraped(metrics, PROGRAMS)).resolves.toBeUndefined();
    await expect(scraped(metrics, SONGS)).resolves.toBeUndefined();
  });

  it('publishes both counts at start and again on each interval', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const { prisma, metrics, service } = build();
    service.onApplicationBootstrap();
    await service.whenStarted();
    await expect(scraped(metrics, PROGRAMS)).resolves.toBe(2);
    await expect(scraped(metrics, SONGS)).resolves.toBe(4);

    prisma.song.count.mockResolvedValue(0);
    prisma.program.count.mockResolvedValue(3);
    await jest.advanceTimersByTimeAsync(RADIO_SCOPE_PREFLIGHT_INTERVAL_MS);
    await expect(scraped(metrics, PROGRAMS)).resolves.toBe(0);
    await expect(scraped(metrics, SONGS)).resolves.toBe(0);

    service.onModuleDestroy();
    service.onModuleDestroy();
    prisma.song.count.mockClear();
    await jest.advanceTimersByTimeAsync(RADIO_SCOPE_PREFLIGHT_INTERVAL_MS);
    expect(prisma.song.count).not.toHaveBeenCalled();
  });

  it('withdraws the counts when a read fails, and publishes them again after', async () => {
    const { prisma, metrics, service } = build();
    await service.refresh();
    prisma.song.count.mockRejectedValueOnce(new Error('secret host'));
    await service.refresh();
    await expect(scraped(metrics, PROGRAMS)).resolves.toBeUndefined();
    await expect(scraped(metrics, SONGS)).resolves.toBeUndefined();
    await service.refresh();
    await expect(scraped(metrics, SONGS)).resolves.toBe(4);
  });

  it('reads nothing on a deploy candidate', async () => {
    process.env.ALCANTARA_DEPLOY_CANDIDATE = '1';
    const { prisma, service } = build();
    service.onApplicationBootstrap();
    await service.whenStarted();
    service.onModuleDestroy();
    expect(prisma.programState.findMany).not.toHaveBeenCalled();
  });
});

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

describe('radio scope preflight, against Postgres', () => {
  const prefix = `preflight-${randomUUID()}`;
  const programs = ['no-row', 'no-team', 'owned', 'television'].map(
    (name) => `${prefix}-${name}`,
  );
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.programState.deleteMany({
      where: { programId: { in: programs } },
    });
    await prisma?.program.deleteMany({
      where: { programId: { in: programs } },
    });
    await prisma?.song.deleteMany({ where: { artist: prefix } });
    await prisma?.$disconnect();
  });

  // The database is shared with other specs, so this counts what its own rows add inside one transaction
  // that no other session sees and that is rolled back.
  it('counts radio programs and songs that a team-scoped read would miss', async () => {
    const read = async (db: PrismaService) => {
      const metrics = new ManagedMetricsService();
      await new RadioScopePreflightService(db, metrics).refresh();
      return [
        (await scraped(metrics, PROGRAMS))!,
        (await scraped(metrics, SONGS))!,
      ];
    };
    const rollback = new Error('rollback');
    await expect(
      prisma.$transaction(
        async (tx) => {
          const before = await read(tx as unknown as PrismaService);
          const [noRow, noTeam, owned, television] = programs;
          for (const [programId, type] of [
            [noRow, 'radio'],
            [noTeam, 'both'],
            [owned, 'radio'],
            [television, 'tv'],
          ]) {
            await tx.programState.create({ data: { programId, type } });
          }
          await tx.program.create({ data: { programId: noTeam } });
          await tx.program.create({ data: { programId: owned, teamId: 7 } });
          for (const [title, teamId] of [
            ['none', null],
            ['zero', 0],
            ['owned', 7],
          ] as const) {
            await tx.song.create({
              data: {
                artist: prefix,
                title,
                audioUrl: `https://media.test/${prefix}/${title}.mp3`,
                teamId,
              },
            });
          }
          const after = await read(tx as unknown as PrismaService);
          expect([after[0] - before[0], after[1] - before[1]]).toEqual([2, 2]);
          throw rollback;
        },
        { isolationLevel: 'RepeatableRead' },
      ),
    ).rejects.toBe(rollback);
  });
});
