import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { RadioMetricsService } from '../radio/radio-metrics.service';
import { AsRunService } from './as-run.service';

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

// The as-run switch's gate (gaulatti/alcantara#122), through the real service: a program's as-run names only its
// team's songs, all of them, and a program with no team names none.
describe("as-run scoped to the program's team, against Postgres", () => {
  const team = 840_000 + (process.pid % 10_000);
  const other = team + 10_000;
  const prefix = `asrun-gate-${randomUUID()}`;
  const mine = `${prefix}-mine`;
  const orphan = `${prefix}-orphan`;
  const ids: Record<string, number> = {};
  const address = (name: string) => `https://media.test/${prefix}/${name}.mp3`;
  const from = new Date('2026-01-01T00:00:00Z');
  const to = new Date('2026-01-02T00:00:00Z');
  let prisma: PrismaService;
  let metrics: RadioMetricsService;
  let service: AsRunService;

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    metrics = new RadioMetricsService();
    // The engine says which song it commanded for a playback named after that song (#729).
    const engine = {
      songIdForPlayback: (_programId: string, playback: string) =>
        ids[playback] ?? null,
    };
    service = new AsRunService(
      prisma,
      { teamId: team } as never,
      engine as never,
      metrics,
    );
    for (const [name, owner] of [
      ['own', team],
      ['theirs', other],
    ] as const) {
      const song = await prisma.song.create({
        data: {
          artist: `${prefix}-${name}`,
          title: name,
          audioUrl: address(name),
          teamId: owner,
        },
      });
      ids[name] = song.id;
      await prisma.mediaAsset.create({
        data: {
          id: `${prefix}-${name}`,
          name: `${name} asset`,
          sourceUrl: address(`${name}-asset`),
          teamId: owner,
        },
      });
    }
    for (const [programId, owner] of [
      [mine, team],
      [orphan, null],
    ] as const) {
      await prisma.program.create({ data: { programId, teamId: owner } });
      for (const name of ['own', 'theirs']) {
        await prisma.asRunRecord.create({
          data: {
            programId,
            songId: ids[name],
            state: 'ended',
            at: new Date('2026-01-01T12:00:00Z'),
          },
        });
      }
    }
  });

  afterAll(async () => {
    const programId = { in: [mine, orphan] };
    await prisma?.asRunRecord.deleteMany({ where: { programId } });
    await prisma?.program.deleteMany({ where: { programId } });
    await prisma?.song.deleteMany({
      where: { teamId: { in: [team, other] } },
    });
    await prisma?.mediaAsset.deleteMany({
      where: { teamId: { in: [team, other] } },
    });
    await prisma?.$disconnect();
  });

  const play = (programId: string, name: string, by: 'url' | 'metadata') =>
    service.resolveSongAndAsset({
      programId,
      ...(by === 'url'
        ? { url: address(name) }
        : { title: name, artist: `${prefix}-${name}` }),
    } as never);

  it("attributes a play to the team's song only, by address and by title", async () => {
    for (const by of ['url', 'metadata'] as const) {
      await expect(play(mine, 'own', by)).resolves.toMatchObject({
        songId: ids.own,
      });
      await expect(play(mine, 'theirs', by)).resolves.toMatchObject({
        songId: null,
      });
      await expect(play(orphan, 'own', by)).resolves.toMatchObject({
        songId: null,
      });
    }
  });

  it("takes the commanded song and a media asset from the program's team only", async () => {
    const resolve = (programId: string, event: Record<string, unknown>) =>
      service.resolveSongAndAsset({ programId, ...event } as never);
    await expect(
      resolve(mine, { playbackRequestId: 'own' }),
    ).resolves.toMatchObject({ songId: ids.own });
    // Another team's commanded song is not read; the address decides.
    await expect(
      resolve(mine, { playbackRequestId: 'theirs', url: address('own') }),
    ).resolves.toMatchObject({ songId: ids.own });
    await expect(
      resolve(orphan, { playbackRequestId: 'own' }),
    ).resolves.toEqual({ songId: null, assetId: null });

    await expect(resolve(mine, { url: address('own-asset') })).resolves.toEqual(
      { songId: null, assetId: `${prefix}-own` },
    );
    for (const [programId, name] of [
      [mine, 'theirs'],
      [orphan, 'own'],
    ]) {
      await expect(
        resolve(programId, { url: address(`${name}-asset`) }),
      ).resolves.toEqual({ songId: null, assetId: null });
    }
  });

  it("names only the team's media assets in the summary", async () => {
    const day = new Date('2026-02-01T12:00:00Z');
    for (const programId of [mine, orphan]) {
      for (const name of ['own', 'theirs']) {
        await prisma.asRunRecord.create({
          data: {
            programId,
            assetId: `${prefix}-${name}`,
            state: 'ended',
            at: day,
          },
        });
      }
    }
    const names = async (programId: string) =>
      (await service.summarizePerformances(programId, day, day))
        .map((row) => row.title)
        .sort();
    await expect(names(mine)).resolves.toEqual(['', 'own asset']);
    await expect(names(orphan)).resolves.toEqual(['', '']);
  });

  it("names only the team's songs in the list, the summary and the export, keeping every row", async () => {
    const titles = async (programId: string) => ({
      list: (await service.listRecords(programId, from, to, 10)).records.map(
        (row) => row.title ?? '',
      ),
      summary: (await service.summarizePerformances(programId, from, to)).map(
        (row) => row.title,
      ),
      export: (await service.exportCsv(programId, from, to))
        .split('\n')
        .slice(1)
        .filter(Boolean)
        .map((line) => line.includes(`${prefix}-own`)),
    });
    const own = await titles(mine);
    expect([...own.list].sort()).toEqual(['', 'own']);
    expect([...own.summary].sort()).toEqual(['', 'own']);
    expect([...own.export].sort()).toEqual([false, true]);

    const none = await titles(orphan);
    expect(none.list).toEqual(['', '']);
    expect(none.summary).toEqual(['', '']);
    expect(none.export).toEqual([false, false]);
  });

  it('counts every refusal and ignores a path it does not know', async () => {
    metrics.recordAsRunScopeRefusal('nonsense' as never);
    const rendered = metrics.render();
    for (const path of ['attribute', 'export', 'summary', 'list']) {
      expect(rendered).toMatch(
        new RegExp(
          `alcantara_as_run_scope_refusals_total\\{path="${path}"\\} [1-9]`,
        ),
      );
    }
    expect(rendered).not.toMatch('nonsense');
  });
});
