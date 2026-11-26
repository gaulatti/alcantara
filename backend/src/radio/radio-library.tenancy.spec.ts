import { Client } from 'pg';
import { ProgramService } from '../program/program.service';
import { PrismaService } from '../prisma.service';
import { forTeam } from '../tenancy/scoped-prisma';
import { RadioService } from './radio.service';

// The radio's gate for scoping the song libraries (gaulatti/alcantara#122): with
// every library row on the station's team, the reads the rotation and the
// Palazzo resolve path make find the same songs through the team-scoped client
// as through the unscoped one. Rotation sequences name songs by id and by audio
// address; these are the lookups behind them.
describe("the radio's song reads through the team-scoped client, against Postgres", () => {
  const team = 880_000 + (process.pid % 10_000);
  const url = process.env.DATABASE_URL;
  const address = (name: string) => `https://media.test/${team}/${name}.mp3`;
  let prisma: PrismaService | null = null;
  let ids: number[] = [];

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
    for (const [name, enabled] of [
      ['one', true],
      ['two', true],
      ['off', false],
    ] as const) {
      const song = await prisma.song.create({
        data: {
          artist: 'Gate',
          title: name,
          audioUrl: address(name),
          coverUrl: `https://media.test/${team}/${name}.jpg`,
          enabled,
          teamId: team,
        },
      });
      ids.push(song.id);
    }
  });

  afterAll(async () => {
    await prisma?.song.deleteMany({ where: { teamId: team } });
    await prisma?.$disconnect();
    ids = [];
  });

  const clients = () => [
    prisma as PrismaService,
    forTeam(prisma as PrismaService, team) as unknown as PrismaService,
  ];

  async function both<T>(read: (db: PrismaService) => Promise<T>) {
    const [unscoped, scoped] = await Promise.all(clients().map(read));
    expect(scoped).toEqual(unscoped);
    return scoped;
  }

  it('selects the same rotation songs', async () => {
    if (!prisma) return;
    // The enabled songs among the ids a rotation holds, as similarity loads them.
    await expect(
      both((db) =>
        db.song.findMany({
          where: { enabled: true, id: { in: ids } },
          orderBy: { id: 'asc' },
        }),
      ),
    ).resolves.toHaveLength(2);
  });

  it('resolves what Palazzo plays to the same song', async () => {
    if (!prisma) return;
    type Resolve = {
      findSongForAnalysis(
        audioUrl: string,
        songId: number | undefined,
        drops: string[],
      ): Promise<unknown>;
    };
    type Cover = {
      storedCoverUrl(audioUrl: string): Promise<string | undefined>;
    };
    const radio = (db: PrismaService) =>
      Object.assign(Object.create(RadioService.prototype) as object, {
        prisma: db,
      }) as unknown as Resolve;
    const programs = (db: PrismaService) =>
      Object.assign(Object.create(ProgramService.prototype) as object, {
        prisma: db,
      }) as unknown as Cover;

    for (const [index, name] of ['one', 'two'].entries()) {
      await expect(
        both((db) =>
          radio(db).findSongForAnalysis(address(name), undefined, []),
        ),
      ).resolves.not.toBeNull();
      await expect(
        both((db) =>
          radio(db).findSongForAnalysis(address(name), ids[index], []),
        ),
      ).resolves.not.toBeNull();
      await expect(
        both((db) => programs(db).storedCoverUrl(address(name))),
      ).resolves.toBe(`https://media.test/${team}/${name}.jpg`);
      // The engine's match of an unannounced track by its address.
      await expect(
        both((db) =>
          db.song.findMany({ where: { audioUrl: address(name) }, take: 2 }),
        ),
      ).resolves.toHaveLength(1);
    }
  });
});
