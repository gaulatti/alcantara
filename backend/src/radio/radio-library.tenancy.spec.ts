import { ProgramService } from '../program/program.service';
import { PrismaService } from '../prisma.service';
import { forTeam } from '../tenancy/scoped-prisma';
import { RadioService } from './radio.service';

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

// The radio's gate for scoping the song libraries (gaulatti/alcantara#122): the
// reads the rotation and the Palazzo resolve path make, through the station
// team's scoped client, find every one of its songs and none of another team's.
// The engine's reads are unscoped today, and still find all of the station's.
// Rotation sequences name songs by id and by audio address; these are the
// lookups behind them.
describe("the radio's song reads through the team-scoped client, against Postgres", () => {
  const team = 880_000 + (process.pid % 10_000);
  const otherTeam = team + 10_000;
  const address = (name: string) => `https://media.test/${team}/${name}.mp3`;
  let prisma: PrismaService;
  let ids: number[] = [];
  let otherIds: number[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    // The length tells one song from another in the analysis lookup, which returns no id.
    for (const [name, enabled, owner, durationMs] of [
      ['one', true, team, 1000],
      ['two', true, team, 2000],
      ['off', false, team, 3000],
      ['theirs', true, otherTeam, 4000],
      ['theirs-off', false, otherTeam, 5000],
    ] as const) {
      const song = await prisma.song.create({
        data: {
          artist: 'Gate',
          title: name,
          audioUrl: address(name),
          coverUrl: `https://media.test/${team}/${name}.jpg`,
          enabled,
          durationMs,
          teamId: owner,
        },
      });
      (owner === team ? ids : otherIds).push(song.id);
    }
  });

  afterAll(async () => {
    await prisma?.song.deleteMany({
      where: { teamId: { in: [team, otherTeam] } },
    });
    await prisma?.$disconnect();
    ids = [];
    otherIds = [];
  });

  const scoped = () =>
    forTeam(prisma as PrismaService, team) as unknown as PrismaService;

  type Resolve = {
    findSongForAnalysis(
      programId: string,
      audioUrl: string,
      songId: number | undefined,
      drops: string[],
    ): Promise<{ durationMs: number | null } | null>;
  };
  type Cover = {
    storedCoverUrl(
      programId: string,
      audioUrl: string,
    ): Promise<string | undefined>;
  };
  const radio = (db: PrismaService) =>
    Object.assign(Object.create(RadioService.prototype) as object, {
      prisma: db,
    }) as unknown as Resolve;
  const programs = (db: PrismaService) =>
    Object.assign(Object.create(ProgramService.prototype) as object, {
      prisma: db,
    }) as unknown as Cover;
  const idsOf = (rows: { id: number }[]) => rows.map((row) => row.id);

  it("reads exactly the station team's songs through the scoped client", async () => {
    await expect(
      scoped()
        .song.findMany({ orderBy: { id: 'asc' } })
        .then(idsOf),
    ).resolves.toEqual(ids);
  });

  it('selects every enabled station song for the rotation, scoped or as the engine reads today', async () => {
    // The enabled songs among the ids a rotation holds, as similarity loads them.
    const rotation = (db: PrismaService, held: number[]) =>
      db.song
        .findMany({
          where: { enabled: true, id: { in: held } },
          orderBy: { id: 'asc' },
        })
        .then(idsOf);
    const held = [...ids, ...otherIds];
    await expect(rotation(scoped(), held)).resolves.toEqual(ids.slice(0, 2));
    await expect(rotation(prisma, ids)).resolves.toEqual(ids.slice(0, 2));
  });

  it("resolves what Palazzo plays to the station's song, never another team's", async () => {
    for (const [index, name] of ['one', 'two'].entries()) {
      for (const db of [prisma, scoped()]) {
        await expect(
          radio(db).findSongForAnalysis('gate', address(name), undefined, []),
        ).resolves.toMatchObject({ durationMs: (index + 1) * 1000 });
        await expect(
          radio(db).findSongForAnalysis('gate', address(name), ids[index], []),
        ).resolves.toMatchObject({ durationMs: (index + 1) * 1000 });
        await expect(
          programs(db).storedCoverUrl('gate', address(name)),
        ).resolves.toBe(`https://media.test/${team}/${name}.jpg`);
        // The engine's match of an unannounced track by its address.
        await expect(
          db.song
            .findMany({ where: { audioUrl: address(name) }, take: 2 })
            .then(idsOf),
        ).resolves.toEqual([ids[index]]);
      }
    }
    await expect(
      radio(scoped()).findSongForAnalysis(
        'gate',
        address('theirs'),
        undefined,
        [],
      ),
    ).resolves.toBeNull();
    await expect(
      radio(scoped()).findSongForAnalysis(
        'gate',
        address('theirs'),
        otherIds[0],
        [],
      ),
    ).resolves.toBeNull();
    await expect(
      programs(scoped()).storedCoverUrl('gate', address('theirs')),
    ).resolves.toBeUndefined();
    await expect(
      scoped().song.findMany({ where: { audioUrl: address('theirs') } }),
    ).resolves.toEqual([]);
  });
});
