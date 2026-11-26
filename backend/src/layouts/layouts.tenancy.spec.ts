import { Client } from 'pg';
import { PrismaService } from '../prisma.service';
import { LayoutsService } from './layouts.service';

// The gate for switching layouts to the scoped client (gaulatti/alcantara#122):
// a team's scoped read returns the rows the unscoped read holds for that team.
describe('layouts scoped to a team, against Postgres', () => {
  const team = 910_000 + (process.pid % 10_000);
  const other = team + 20_000;
  const url = process.env.DATABASE_URL;
  let prisma: PrismaService | null = null;

  beforeAll(async () => {
    if (!url) return;
    const probe = new Client({ connectionString: url });
    try {
      await probe.connect();
      await probe.end();
    } catch {
      return;
    }
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.layout.createMany({
      data: [
        { name: 'b', componentType: 't', settings: '{}', teamId: team },
        { name: 'a', componentType: 't', settings: '{}', teamId: team },
        { name: 'c', componentType: 't', settings: '{}', teamId: other },
      ],
    });
  });

  afterAll(async () => {
    await prisma?.layout.deleteMany({
      where: { teamId: { in: [team, other] } },
    });
    await prisma?.$disconnect();
  });

  it("returns the team's rows, the same as the unscoped read holds for it", async () => {
    if (!prisma) return;
    const service = new LayoutsService(prisma, {} as never);
    const unscoped = await service.findAll();
    const mine = unscoped.filter((row) => row.teamId === team);
    expect(mine.map((row) => row.name)).toEqual(['a', 'b']);
    await expect(service.findAll(team)).resolves.toEqual(mine);
    for (const row of mine) {
      await expect(service.findOne(row.id, team)).resolves.toEqual(
        await service.findOne(row.id),
      );
    }
  });

  it("does not read or delete another team's layout", async () => {
    if (!prisma) return;
    const service = new LayoutsService(prisma, {} as never);
    const theirs = await prisma.layout.findFirstOrThrow({
      where: { teamId: other },
    });
    await expect(service.findOne(theirs.id, team)).resolves.toBeNull();
    await expect(service.remove(theirs.id, team)).rejects.toMatchObject({
      code: 'P2025',
    });
    await expect(service.findOne(theirs.id, other)).resolves.not.toBeNull();
  });
});
