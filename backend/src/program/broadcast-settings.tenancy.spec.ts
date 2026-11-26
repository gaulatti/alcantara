import { Client } from 'pg';
import { PrismaService } from '../prisma.service';
import { ProgramService } from './program.service';

// The gate for scoping the write of the one broadcast settings row to its team
// (gaulatti/alcantara#122). The read stays public: programme pages load it.
describe('broadcast settings written by a team, against Postgres', () => {
  const team = 970_000 + (process.pid % 10_000);
  const url = process.env.DATABASE_URL;
  let prisma: PrismaService | null = null;
  let before: { teamId: number | null } | null = null;

  const service = () =>
    new (ProgramService as unknown as new (db: unknown) => ProgramService)(
      prisma,
    );
  const stored = () =>
    prisma!.broadcastSettings.findUnique({ where: { id: 1 } });

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
    if (!prisma) return;
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
