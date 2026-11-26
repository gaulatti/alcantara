import { noRecorder } from '../operator-change/operator-change-recorder.testing';
import { PrismaService } from '../prisma.service';
import { StingersService } from './stingers.service';

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

// The gate for switching stingers to the scoped client (gaulatti/alcantara#122):
// a team's scoped read returns the rows the unscoped read holds for that team.
describe('stingers scoped to a team, against Postgres', () => {
  const team = 950_000 + (process.pid % 10_000);
  const other = team + 20_000;
  let prisma: PrismaService;
  const created: number[] = [];

  const service = () =>
    new StingersService(prisma as PrismaService, noRecorder());
  const input = (name: string) => ({
    name,
    videoUrl: `https://media.test/${name}.webm`,
  });

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const id of created) {
      await service()
        .remove(id)
        .catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  it("creates, reads and changes only the team's stingers and their assets", async () => {
    const mine = await service().create(input('mine'), team);
    const theirs = await service().create(input('theirs'), other);
    created.push(mine.id, theirs.id);
    expect(mine.teamId).toBe(team);
    await expect(
      prisma.mediaAsset.findUnique({ where: { id: mine.assetId! } }),
    ).resolves.toMatchObject({ teamId: team });

    const unscoped = (await service().findAll()).filter(
      (row) => row.teamId === team,
    );
    expect(unscoped.map((row) => row.id)).toEqual([mine.id]);
    await expect(service().findAll(team)).resolves.toEqual(unscoped);
    await expect(service().findOne(mine.id, team)).resolves.toEqual(
      await service().findOne(mine.id),
    );

    await expect(
      service().update(mine.id, { name: 'renamed' }, team),
    ).resolves.toMatchObject({ name: 'renamed', teamId: team });
    await expect(service().findOne(theirs.id, team)).rejects.toThrow(
      'Stinger not found',
    );
    await expect(
      service().update(theirs.id, { name: 'x' }, team),
    ).rejects.toThrow('Stinger not found');
    await expect(service().remove(theirs.id, team)).rejects.toThrow(
      'Stinger not found',
    );
    await expect(service().remove(mine.id, team)).resolves.toEqual({
      deletedStingerId: mine.id,
    });
    await expect(service().findOne(theirs.id, other)).resolves.toMatchObject({
      name: 'theirs',
    });
  });
});
