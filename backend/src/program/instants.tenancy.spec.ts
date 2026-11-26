import { Client } from 'pg';
import { noRecorder } from '../operator-change/operator-change-recorder.testing';
import { PrismaService } from '../prisma.service';
import { ProgramService } from './program.service';

// The gate for switching instants to the scoped client (gaulatti/alcantara#122):
// a team's scoped read returns the rows the unscoped read holds for that team.
describe('instants scoped to a team, against Postgres', () => {
  const team = 990_000 + (process.pid % 5_000);
  const other = team + 5_000;
  const url = process.env.DATABASE_URL;
  let prisma: PrismaService | null = null;
  const created: number[] = [];

  const service = () => {
    const programs = new (ProgramService as unknown as new (
      db: unknown,
    ) => ProgramService)(prisma);
    Object.assign(programs, { operatorChanges: noRecorder() });
    jest
      .spyOn(programs as never, 'requireRecorder')
      .mockReturnValue(noRecorder() as never);
    jest.spyOn(programs, 'broadcastUpdate').mockImplementation(() => undefined);
    return programs;
  };
  const clip = (name: string) => ({
    name,
    audioUrl: `https://media.test/${name}-${team}.mp3`,
  });

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
    for (const id of created) {
      await service()
        .deleteInstant(id)
        .catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  it("creates, reads, changes and deletes only the team's instants", async () => {
    if (!prisma) return;
    const mine = (await service().createInstant(clip('mine'), team))!;
    const theirs = (await service().createInstant(clip('theirs'), other))!;
    created.push(mine.id, theirs.id);
    expect(mine.teamId).toBe(team);
    await expect(
      prisma.mediaAsset.findUnique({ where: { id: mine.assetId! } }),
    ).resolves.toMatchObject({ teamId: team });

    const unscoped = (await service().listInstants()).filter(
      (row) => row.teamId === team,
    );
    expect(unscoped.map((row) => row.id)).toEqual([mine.id]);
    await expect(service().listInstants(undefined, team)).resolves.toEqual(
      unscoped,
    );

    await expect(
      service().updateInstant(mine.id, { volume: 0.5 }, team),
    ).resolves.toMatchObject({ volume: 0.5, teamId: team });
    for (const call of [
      () => service().updateInstant(theirs.id, { volume: 0 }, team),
      () => service().deleteInstant(theirs.id, team),
      () => service().playInstant(theirs.id, 'main', team),
    ]) {
      await expect(call()).rejects.toThrow('Instant not found');
    }
    await expect(service().deleteInstant(mine.id, team)).resolves.toEqual({
      deletedInstantId: mine.id,
    });
    await expect(
      prisma.instant.findUnique({ where: { id: theirs.id } }),
    ).resolves.toMatchObject({ teamId: other });
  });
});
