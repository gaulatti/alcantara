import { PrismaService } from '../prisma.service';
import { ProgramService } from './program.service';

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

// The gate for scoping the write of the one broadcast settings row to its team
// (gaulatti/alcantara#122). The read stays public: programme pages load it.
describe('broadcast settings written by a team, against Postgres', () => {
  const team = 970_000 + (process.pid % 10_000);
  let prisma: PrismaService;
  let before: { teamId: number | null } | null = null;

  const service = () =>
    new (ProgramService as unknown as new (db: unknown) => ProgramService)(
      prisma,
    );
  const stored = () =>
    prisma!.broadcastSettings.findUnique({ where: { id: 1 } });

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    if (before) {
      await prisma?.broadcastSettings.update({
        where: { id: 1 },
        data: { teamId: before.teamId },
      });
    }
    await prisma?.$disconnect();
  });

  it("refuses another team and keeps the owning team's write on its row", async () => {
    await prisma.broadcastSettings.upsert({
      where: { id: 1 },
      create: { id: 1, teamId: team },
      update: {},
    });
    before = await stored();
    await prisma.broadcastSettings.update({
      where: { id: 1 },
      data: { teamId: team, songMasterVolume: 1 },
    });

    await expect(
      service().updateBroadcastSettings({ songMasterVolume: 0.5 }, team + 1),
    ).rejects.toThrow('Broadcast settings not found');
    await expect(stored()).resolves.toMatchObject({ songMasterVolume: 1 });

    const writer = service();
    jest.spyOn(writer, 'broadcastUpdate').mockImplementation(() => undefined);
    jest.spyOn(writer, 'listPrograms').mockResolvedValue([]);
    await writer.updateBroadcastSettings({ songMasterVolume: 0.5 }, team);
    await expect(stored()).resolves.toMatchObject({
      songMasterVolume: 0.5,
      teamId: team,
    });
  });
});
