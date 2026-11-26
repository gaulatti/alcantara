import { PrismaService } from '../prisma.service';
import { ScenesService } from './scenes.service';

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

// The gate for switching scenes to the scoped client (gaulatti/alcantara#122):
// a team's scoped read returns the rows the unscoped read holds for that team.
describe('scenes scoped to a team, against Postgres', () => {
  const team = 930_000 + (process.pid % 10_000);
  const other = team + 20_000;
  const programs = {
    getProgramIdsByAssignedScene: jest.fn().mockResolvedValue([]),
    getProgramIdsByActiveScene: jest.fn().mockResolvedValue([]),
    clearActiveScene: jest.fn().mockResolvedValue([]),
  };
  let prisma: PrismaService;
  let layoutId = 0;

  const service = () =>
    new ScenesService(prisma as PrismaService, programs as never, {} as never);

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    const layout = await prisma.layout.create({
      data: { name: 'l', componentType: 't', settings: '{}', teamId: team },
    });
    layoutId = layout.id;
    await prisma.scene.createMany({
      data: [
        { name: 'one', layoutId, teamId: team },
        { name: 'two', layoutId, teamId: team },
        { name: 'theirs', layoutId, teamId: other },
      ],
    });
  });

  afterAll(async () => {
    await prisma?.scene.deleteMany({
      where: { teamId: { in: [team, other] } },
    });
    await prisma?.layout.deleteMany({ where: { id: layoutId } });
    await prisma?.$disconnect();
  });

  it("returns the team's rows, the same as the unscoped read holds for it", async () => {
    const mine = (await service().findAll()).filter(
      (row) => row.teamId === team,
    );
    expect(mine.map((row) => row.name).sort()).toEqual(['one', 'two']);
    await expect(service().findAll(team)).resolves.toEqual(mine);
    for (const row of mine) {
      await expect(service().findOne(row.id, team)).resolves.toEqual(
        await service().findOne(row.id),
      );
    }
  });

  it("does not read, change or delete another team's scene", async () => {
    const theirs = await prisma.scene.findFirstOrThrow({
      where: { teamId: other },
    });
    await expect(service().findOne(theirs.id, team)).resolves.toBeNull();
    await expect(
      service().updateChyron(theirs.id, 'x', team),
    ).rejects.toMatchObject({ code: 'P2025' });
    await expect(service().remove(theirs.id, team)).rejects.toThrow(
      'Scene not found',
    );
    expect(programs.clearActiveScene).not.toHaveBeenCalled();
    await expect(service().findOne(theirs.id, other)).resolves.not.toBeNull();
    await service().remove(theirs.id, other);
    await expect(service().findOne(theirs.id)).resolves.toBeNull();
  });

  it("does not put a scene on another team's layout", async () => {
    await expect(
      service().create({ name: 'n', layoutId }, other),
    ).rejects.toThrow('Layout not found');
  });
});
