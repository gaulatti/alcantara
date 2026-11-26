import { randomUUID } from 'node:crypto';
import { noRecorder } from '../operator-change/operator-change-recorder.testing';
import { PrismaService } from '../prisma.service';
import { SongsService } from './songs.service';

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

// The gate for switching songs to the scoped client (gaulatti/alcantara#122):
// a team's scoped read returns the rows the unscoped read holds for that team.
describe('songs scoped to a team, against Postgres', () => {
  const team = 800_000 + (process.pid % 10_000);
  const other = team + 10_000;
  const search = `gate-${team}-${randomUUID()}`;
  const page = { search, page: 1, limit: 50 };
  let prisma: PrismaService;

  const service = () => new SongsService(prisma, noRecorder());
  const song = (name: string) => ({
    artist: search,
    title: name,
    audioUrl: `https://media.test/${randomUUID()}.mp3`,
    durationMs: 1000,
  });

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    const where = { teamId: { in: [team, other] } };
    await prisma?.song.deleteMany({ where });
    await prisma?.mediaAsset.deleteMany({ where });
    await prisma?.$disconnect();
  });

  it("creates, reads, changes and removes only the team's songs", async () => {
    const mine = (await service().create(song('mine'), team))!;
    const theirs = (await service().create(song('theirs'), other))!;
    expect(mine.teamId).toBe(team);
    await expect(
      prisma.mediaAsset.findUnique({ where: { id: mine.assetId! } }),
    ).resolves.toMatchObject({ teamId: team });

    const unscoped = (await service().findAll(page)).data.filter(
      (row) => row.teamId === team,
    );
    const scoped = await service().findAll(page, team);
    expect(scoped.data).toEqual(unscoped);
    expect(scoped.meta).toMatchObject({
      total: 1,
      catalogTotal: 1,
      catalogEnabled: 1,
      catalogTotalDurationMs: 1000,
    });
    await expect(service().findOne(mine.id, undefined, team)).resolves.toEqual(
      await service().findOne(mine.id),
    );
    await expect(
      service().update(mine.id, { title: 'renamed' }, team),
    ).resolves.toMatchObject({ title: 'renamed', teamId: team });

    for (const call of [
      () => service().findOne(theirs.id, undefined, team),
      () => service().update(theirs.id, { title: 'x' }, team),
      () => service().remove(theirs.id, team),
    ]) {
      await expect(call()).rejects.toThrow('Song not found');
    }
    await expect(service().remove(mine.id, team)).resolves.toEqual({
      deletedSongId: mine.id,
    });
    await expect(
      service().findOne(theirs.id, undefined, other),
    ).resolves.toMatchObject({ title: 'theirs' });
  });
});
