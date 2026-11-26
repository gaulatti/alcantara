import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import { ProgramService } from './program.service';
import { SceneAssetScope } from './scene-asset-scope';

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

// gaulatti/alcantara#122, through the real take: a program plays its team's background asset, and one it may not
// read through its team still plays, and is counted. An on-air path never goes silent from scoping.
describe("scene background audio and the program's team, against Postgres", () => {
  const team = 890_000 + (process.pid % 10_000);
  const other = team + 10_000;
  const prefix = `scene-gate-${randomUUID()}`;
  const mine = `${prefix}-mine`;
  const orphan = `${prefix}-orphan`;
  const own = `${prefix}-own`;
  const theirs = `${prefix}-theirs`;
  let prisma: PrismaService;
  let metrics: ManagedMetricsService;
  let service: ProgramService;
  let sceneId: number;
  let warn: jest.SpyInstance;

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    prisma = new PrismaService();
    await prisma.$connect();
    for (const [id, teamId] of [
      [own, team],
      [theirs, other],
    ] as const) {
      await prisma.mediaAsset.create({
        data: {
          id,
          name: id,
          sourceUrl: `https://media.test/${id}.mp3`,
          teamId,
          backgroundAudio: { create: {} },
        },
      });
    }
    const layout = await prisma.layout.create({
      data: { name: prefix, componentType: 'test', settings: '{}' },
    });
    const scene = await prisma.scene.create({
      data: { name: prefix, layoutId: layout.id },
    });
    sceneId = scene.id;
    for (const [programId, teamId] of [
      [mine, team],
      [orphan, null],
    ] as const) {
      await prisma.program.create({ data: { programId, teamId } });
      await prisma.programState.create({
        data: {
          programId,
          scenes: { create: { sceneId, position: 0 } },
        },
      });
    }
  });

  beforeEach(() => {
    metrics = new ManagedMetricsService();
    service = new ProgramService(
      prisma,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      new SceneAssetScope(prisma, { teamId: team } as never, metrics),
    );
    jest.spyOn(service, 'broadcastUpdate').mockReturnValue(undefined as never);
  });

  afterAll(async () => {
    const programId = { in: [mine, orphan] };
    await prisma?.programState.deleteMany({ where: { programId } });
    await prisma?.program.deleteMany({ where: { programId } });
    await prisma?.scene.deleteMany({ where: { name: prefix } });
    await prisma?.layout.deleteMany({ where: { name: prefix } });
    await prisma?.mediaAsset.deleteMany({
      where: { teamId: { in: [team, other] } },
    });
    await prisma?.$disconnect();
    warn.mockRestore();
  });

  const take = (programId: string, assetId: string) =>
    service.takeProgramSceneInstant(sceneId, programId, null, assetId);
  const refusals = async () =>
    (await metrics.registry.metrics())
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('alcantara_scene_asset_scope_refusals_total{') &&
          !line.endsWith(' 0'),
      )
      .map(
        (line) => `${/reason="([^"]+)"/.exec(line)?.[1]} ${line.split(' ')[1]}`,
      );

  it("plays the team's asset and counts nothing", async () => {
    await expect(take(mine, own)).resolves.toMatchObject({
      mediaAssetId: own,
      isPlaying: true,
    });
    await expect(refusals()).resolves.toEqual([]);
  });

  it.each([
    ["another team's asset", () => mine, () => theirs, 'other-team 1'],
    ['a program with no team', () => orphan, () => own, 'no-team 1'],
  ])('still plays %s, and counts it', async (_case, program, asset, count) => {
    await expect(take(program(), asset())).resolves.toMatchObject({
      mediaAssetId: asset(),
      isPlaying: true,
    });
    await expect(refusals()).resolves.toEqual([count]);
  });

  it('still refuses an asset that does not exist, as before', async () => {
    await expect(take(mine, `${prefix}-missing`)).rejects.toThrow(
      'Configured background audio asset not found',
    );
    await expect(refusals()).resolves.toEqual([]);
  });
});
