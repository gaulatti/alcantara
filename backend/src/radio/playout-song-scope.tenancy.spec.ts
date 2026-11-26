import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ProgramService } from '../program/program.service';
import { PrismaService } from '../prisma.service';
import { NowPlayingPublisherService } from './now-playing-publisher.service';
import { PlayoutSongScope } from './playout-song-scope';
import { RadioMetricsService } from './radio-metrics.service';
import { RadioService } from './radio.service';
import { SongExecutionEngine } from './song-execution.engine';

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

// The playout switch's gate (gaulatti/alcantara#122), through the four real methods: a program reads its team's song,
// and a song only another team has, or a program with no team, is still read and counted.
describe('playout song reads and the program team, against Postgres', () => {
  const team = 860_000 + (process.pid % 10_000);
  const other = team + 10_000;
  const prefix = `playout-gate-${randomUUID()}`;
  const mine = `${prefix}-mine`;
  const orphan = `${prefix}-orphan`;
  const address = (name: string) => `https://media.test/${prefix}/${name}.mp3`;
  const cover = (name: string) => `https://media.test/${prefix}/${name}.jpg`;
  const ids: Record<string, number> = {};
  let prisma: PrismaService;
  let metrics: RadioMetricsService;
  let scope: PlayoutSongScope;
  let warn: jest.SpyInstance;

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    prisma = new PrismaService();
    await prisma.$connect();
    // Two songs share one address across the teams; the other team's row is the older one.
    for (const [name, owner, file] of [
      ['theirs-shared', other, 'shared'],
      ['own-shared', team, 'shared'],
      ['theirs', other, 'theirs'],
    ] as const) {
      const song = await prisma.song.create({
        data: {
          artist: prefix,
          title: name,
          audioUrl: address(file),
          coverUrl: cover(name),
          durationMs: 1000,
          teamId: owner,
        },
      });
      ids[name] = song.id;
    }
    await prisma.program.create({ data: { programId: mine, teamId: team } });
    await prisma.program.create({ data: { programId: orphan, teamId: null } });
  });

  beforeEach(() => {
    metrics = new RadioMetricsService();
    scope = new PlayoutSongScope(prisma, { teamId: team } as never, metrics);
  });

  afterAll(async () => {
    await prisma?.program.deleteMany({
      where: { programId: { in: [mine, orphan] } },
    });
    await prisma?.song.deleteMany({
      where: { teamId: { in: [team, other] } },
    });
    await prisma?.$disconnect();
    warn.mockRestore();
  });

  const refusals = (path: string) =>
    metrics
      .render()
      .split('\n')
      .filter((line) =>
        line.startsWith(
          `alcantara_radio_song_scope_refusals_total{path="${path}"`,
        ),
      )
      .filter((line) => !line.endsWith(' 0'))
      .map(
        (line) => `${/reason="([^"]+)"/.exec(line)?.[1]} ${line.split(' ')[1]}`,
      );

  const radio = () =>
    new RadioService(
      prisma,
      {} as never,
      {} as never,
      metrics,
      { teamId: team } as never,
      scope,
    ) as any;
  const analysis = (programId: string, url: string, songId?: number) =>
    radio().findSongForAnalysis(programId, url, songId, []);

  it('analysis, by id and by address', async () => {
    const found = { assetId: null, durationMs: 1000 };
    await expect(analysis(mine, '', ids['own-shared'])).resolves.toEqual(found);
    // The shared address names one song within the team, where it named two before.
    await expect(analysis(mine, address('shared'))).resolves.toEqual(found);
    expect(refusals('analysis')).toEqual([]);

    await expect(analysis(mine, '', ids.theirs)).resolves.toEqual(found);
    await expect(analysis(mine, address('theirs'))).resolves.toEqual(found);
    expect(refusals('analysis')).toEqual(['other-team 2']);

    await expect(analysis(orphan, address('theirs'))).resolves.toEqual(found);
    expect(refusals('analysis')).toEqual(['no-team 1', 'other-team 2']);
  });

  it('now-playing artwork', async () => {
    const publisher = new NowPlayingPublisherService(
      prisma,
      undefined,
      undefined,
      scope,
    ) as any;
    const artwork = (programId: string, file: string) =>
      publisher.resolveArtworkUrl(programId, { audioUrl: address(file) });
    await expect(artwork(mine, 'shared')).resolves.toBe(cover('own-shared'));
    expect(refusals('artwork')).toEqual([]);
    await expect(artwork(mine, 'theirs')).resolves.toBe(cover('theirs'));
    await expect(artwork(orphan, 'theirs')).resolves.toBe(cover('theirs'));
    expect(refusals('artwork')).toEqual(['no-team 1', 'other-team 1']);
  });

  it("the playing track's cover", async () => {
    const service = new ProgramService(
      prisma,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      scope,
    ) as any;
    const coverOf = (programId: string, file: string) =>
      service.storedCoverUrl(programId, address(file));
    await expect(coverOf(mine, 'shared')).resolves.toBe(cover('own-shared'));
    expect(refusals('cover')).toEqual([]);
    await expect(coverOf(mine, 'theirs')).resolves.toBe(cover('theirs'));
    await expect(coverOf(orphan, 'theirs')).resolves.toBe(cover('theirs'));
    expect(refusals('cover')).toEqual(['no-team 1', 'other-team 1']);
  });

  it('recognising an unannounced track', async () => {
    const engine = new SongExecutionEngine(
      {} as never,
      {} as never,
      prisma,
      {} as never,
      metrics,
      undefined,
      scope,
    ) as any;
    // The track is no longer withheld when the answer arrives, so only the lookup runs.
    jest.spyOn(engine, 'stillWithheld').mockReturnValue(false);
    const read = jest.spyOn(scope, 'read');
    const recognise = async (programId: string, file: string) => {
      read.mockClear();
      await engine.recogniseInheritedTrack(
        programId,
        {},
        { track: { url: address(file) } },
        'request',
      );
      const rows = (await read.mock.results[0].value) as { id: number }[];
      return rows.map((row) => row.id).sort((a, b) => a - b);
    };
    await expect(recognise(mine, 'shared')).resolves.toEqual([
      ids['own-shared'],
    ]);
    expect(refusals('recognise')).toEqual([]);
    await expect(recognise(mine, 'theirs')).resolves.toEqual([ids.theirs]);
    await expect(recognise(orphan, 'shared')).resolves.toEqual([
      ids['theirs-shared'],
      ids['own-shared'],
    ]);
    expect(refusals('recognise')).toEqual(['no-team 1', 'other-team 1']);
  });
});
