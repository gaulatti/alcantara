import { noRecorder } from '../operator-change/operator-change-recorder.testing';
import { PrismaService } from '../prisma.service';
import { MediaService } from './media.service';

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

// The gate for switching media to the scoped client (gaulatti/alcantara#122):
// a team's scoped read returns the rows the unscoped read holds for that team.
describe('media scoped to a team, against Postgres', () => {
  const team = 840_000 + (process.pid % 10_000);
  const other = team + 10_000;
  const page = { page: 1, limit: 200, search: `gate-${team}` };
  let prisma: PrismaService;

  const service = () => new MediaService(prisma, noRecorder());
  const image = (name: string) => ({
    name: `gate-${team} ${name}`,
    imageUrl: `https://media.test/${team}/${name}.png`,
  });

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    const where = { teamId: { in: [team, other] } };
    await prisma?.mediaGroup.deleteMany({ where });
    await prisma?.mediaLabel.deleteMany({ where });
    await prisma?.media.deleteMany({ where });
    await prisma?.mediaAsset.deleteMany({ where });
    await prisma?.$disconnect();
  });

  it("creates, reads, changes and deletes only the team's media", async () => {
    const mine = await service().create(image('mine'), team);
    const theirs = await service().create(image('theirs'), other);
    expect(mine.teamId).toBe(team);
    await expect(
      prisma.mediaAsset.findUnique({ where: { id: mine.assetId! } }),
    ).resolves.toMatchObject({ teamId: team });

    const unscoped = (await service().findAll(page)).data.filter(
      (row) => row.teamId === team,
    );
    expect(unscoped.map((row) => row.id)).toEqual([mine.id]);
    await expect(service().findAll(page, team)).resolves.toMatchObject({
      data: unscoped,
      meta: { total: 1 },
    });
    await expect(
      service().update(mine.id, { name: `gate-${team} renamed` }, team),
    ).resolves.toMatchObject({ teamId: team });

    for (const call of [
      () => service().findOne(theirs.id, team),
      () => service().update(theirs.id, { name: 'x' }, team),
      () => service().remove(theirs.id, team),
    ]) {
      await expect(call()).rejects.toThrow('Media not found');
    }

    const group = await prisma.mediaGroup.create({
      data: {
        name: `gate-${team}`,
        teamId: team,
        mediaItems: { create: { mediaId: mine.id, position: 0 } },
      },
    });
    await expect(service().remove(mine.id, team)).resolves.toEqual({
      deletedMediaId: mine.id,
    });
    await expect(
      prisma.mediaLabel.findUnique({
        where: { id: `legacy-media-group:${group.id}` },
      }),
    ).resolves.toMatchObject({ teamId: team });
    await expect(service().findOne(theirs.id, other)).resolves.toMatchObject({
      id: theirs.id,
    });
  });
});
