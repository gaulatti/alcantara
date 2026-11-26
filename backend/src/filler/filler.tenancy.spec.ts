import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { MediaAssetType } from '@prisma/client';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import { FillerService } from './filler.service';

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

// gaulatti/alcantara#122: a program's filler may use its team's media assets only.
describe("filler preparation and the program's team, against Postgres", () => {
  const team = 880_000 + (process.pid % 10_000);
  const other = team + 10_000;
  const prefix = `filler-gate-${randomUUID()}`;
  const mine = `${prefix}-mine`;
  const orphan = `${prefix}-orphan`;
  const asset = (owner: string, kind: string) => `${prefix}-${owner}-${kind}`;
  let prisma: PrismaService;
  let metrics: ManagedMetricsService;
  let service: FillerService;

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    for (const [owner, teamId] of [
      ['own', team],
      ['theirs', other],
    ] as const) {
      for (const [kind, mediaType] of [
        ['picture', MediaAssetType.IMAGE],
        ['sound', MediaAssetType.AUDIO],
      ] as const) {
        await prisma.mediaAsset.create({
          data: {
            id: asset(owner, kind),
            name: kind,
            mediaType,
            sourceUrl: 'https://elsewhere.example.test/file',
            teamId,
          },
        });
      }
    }
    for (const [programId, teamId] of [
      [mine, team],
      [orphan, null],
    ] as const) {
      await prisma.program.create({ data: { programId, teamId } });
      await prisma.programState.create({
        data: { programId, type: 'both', radioSettings: { create: {} } },
      });
    }
  });

  beforeEach(() => {
    metrics = new ManagedMetricsService();
    // Alana has no live profile and the bucket is not configured: an accepted asset fails at the next step.
    service = new FillerService(
      prisma,
      { liveProfile: () => Promise.resolve(null) } as never,
      {} as never,
      new ConfigService({}),
      metrics,
      { teamId: team } as never,
    );
  });

  afterAll(async () => {
    const programId = { in: [mine, orphan] };
    await prisma?.programState.deleteMany({ where: { programId } });
    await prisma?.program.deleteMany({ where: { programId } });
    await prisma?.mediaAsset.deleteMany({
      where: { teamId: { in: [team, other] } },
    });
    await prisma?.$disconnect();
  });

  const television = (programId: string, owner: string) =>
    service.prepareTelevision(
      programId,
      { assetId: asset(owner, 'picture') },
      'tester',
    );
  const radio = (programId: string, owners: string[]) =>
    service.prepareRadio(
      programId,
      { assetIds: owners.map((owner) => asset(owner, 'sound')) },
      'tester',
    );

  it("accepts the team's television asset and refuses another team's", async () => {
    await expect(television(mine, 'own')).rejects.toThrow(
      'television live profile unavailable',
    );
    await expect(television(mine, 'theirs')).rejects.toThrow(
      'television filler must be an enabled image or video media asset',
    );
  });

  it("accepts the team's radio assets and refuses a list holding another team's", async () => {
    const accepted: unknown = await radio(mine, ['own']).catch(
      (error: unknown) => error,
    );
    expect(String(accepted)).toContain('managed media bucket is unavailable');
    expect(String(accepted)).not.toContain('enabled audio media asset');
    await expect(radio(mine, ['own', 'theirs'])).rejects.toThrow(
      'every radio filler source must be an enabled audio media asset',
    );
  });

  it('refuses a program with no team, and counts it', async () => {
    await expect(television(orphan, 'own')).rejects.toThrow(
      'this program has no team',
    );
    await expect(radio(orphan, ['own'])).rejects.toThrow(
      'this program has no team',
    );
    const rendered = await metrics.render('');
    for (const leg of ['television', 'radio']) {
      expect(rendered).toMatch(
        new RegExp(
          `alcantara_filler_preparations_total\\{leg="${leg}",result="no-team"\\} 1`,
        ),
      );
    }
  });
});
