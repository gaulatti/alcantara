import { noRecorder } from '../operator-change/operator-change-recorder.testing';
import { PrismaService } from '../prisma.service';
import { MediaGroupsService } from './media-groups.service';

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

// The gate for switching media groups to the scoped client (gaulatti/alcantara#122):
// a team's scoped read returns the rows the unscoped read holds for that team.
describe('media groups scoped to a team, against Postgres', () => {
  const team = 860_000 + (process.pid % 10_000);
  const other = team + 10_000;
  const page = { page: 1, limit: 0 };
  let prisma: PrismaService;

  const service = () =>
    new MediaGroupsService(prisma as PrismaService, noRecorder());

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.mediaGroup.deleteMany({
      where: { teamId: { in: [team, other] } },
    });
    await prisma?.mediaLabel.deleteMany({
      where: { teamId: { in: [team, other] } },
    });
    await prisma?.$disconnect();
  });

  it("creates, reads and changes only the team's groups and their labels", async () => {
    const mine = await service().create({ name: `mine ${team}` }, team);
    const theirs = await service().create({ name: `theirs ${team}` }, other);
    await expect(
      prisma.mediaLabel.findUnique({
        where: { id: `legacy-media-group:${mine.id}` },
      }),
    ).resolves.toMatchObject({ teamId: team });

    const scoped = await service().findAll(page, team);
    expect(scoped.data.map((group) => group.id)).toEqual([mine.id]);
    await expect(service().findOne(mine.id, team)).resolves.toEqual(
      await service().findOne(mine.id),
    );
    await expect(
      service().update(mine.id, { description: 'd' }, team),
    ).resolves.toMatchObject({ description: 'd' });

    for (const call of [
      () => service().findOne(theirs.id, team),
      () => service().update(theirs.id, { description: 'x' }, team),
      () => service().remove(theirs.id, team),
    ]) {
      await expect(call()).rejects.toThrow('Media group not found');
    }
    await expect(service().remove(mine.id, team)).resolves.toEqual({
      deletedMediaGroupId: mine.id,
    });
    await expect(service().findOne(theirs.id, other)).resolves.toMatchObject({
      description: null,
    });
  });
});
