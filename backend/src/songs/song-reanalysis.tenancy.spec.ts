import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { SongReanalysisService } from './song-reanalysis.service';

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

// gaulatti/alcantara#122: a team queues a new analysis of its own songs only.
describe("song re-analysis and the caller's team, against Postgres", () => {
  const team = 900_000 + (process.pid % 10_000);
  const other = team + 10_000;
  const prefix = `reanalysis-gate-${randomUUID()}`;
  const ids: Record<string, number> = {};
  let prisma: PrismaService;
  const looked: number[] = [];
  let service: SongReanalysisService;

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    for (const [name, teamId] of [
      ['own', team],
      ['theirs', other],
    ] as const) {
      const song = await prisma.song.create({
        data: {
          artist: prefix,
          title: name,
          audioUrl: `https://media.test/${prefix}/${name}.mp3`,
          teamId,
        },
      });
      ids[name] = song.id;
      await prisma.mediaAsset.create({
        data: {
          id: `song:${song.id}`,
          name,
          sourceUrl: song.audioUrl,
          teamId,
          analysis: { create: { status: 'success' } },
        },
      });
    }
    service = new SongReanalysisService(prisma, {
      programsHoldingSongs: (songs: { id: number }[]) => {
        looked.push(...songs.map((song) => song.id));
        return Promise.resolve(new Map<number, string[]>());
      },
    } as never);
  });

  afterAll(async () => {
    await prisma?.mediaAsset.deleteMany({
      where: { teamId: { in: [team, other] } },
    });
    await prisma?.song.deleteMany({
      where: { teamId: { in: [team, other] } },
    });
    await prisma?.$disconnect();
  });

  const due = async (name: string) =>
    (
      await prisma.mediaAssetAnalysis.findUnique({
        where: { assetId: `song:${ids[name]}` },
      })
    )?.nextAttemptAt ?? null;

  it("queues the team's song and lists another team's as skipped, untouched", async () => {
    const now = new Date('2026-11-26T12:00:00.000Z');
    await expect(
      service.request([ids.own, ids.theirs], team, undefined, now),
    ).resolves.toEqual({ requested: 1, skipped: [ids.theirs] });
    await expect(due('own')).resolves.toEqual(now);
    await expect(due('theirs')).resolves.toBeNull();
    expect(looked).not.toContain(ids.theirs);
  });

  it("does not say where another team's song is on air", async () => {
    looked.length = 0;
    await service.onAir([ids.own, ids.theirs], team);
    expect(looked).toEqual([ids.own]);
  });

  it('queues any song when no team is configured', async () => {
    await expect(service.request([ids.theirs], 0)).resolves.toEqual({
      requested: 1,
      skipped: [],
    });
  });
});
