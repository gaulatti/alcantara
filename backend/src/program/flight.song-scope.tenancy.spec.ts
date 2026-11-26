import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { RadioMetricsService } from '../radio/radio-metrics.service';
import { RadioService } from '../radio/radio.service';
import { FlightService } from './flight.service';
import { RecipesService } from './recipes.service';

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

// The logs switch's gate (gaulatti/alcantara#122): the song reads of radio logs, cues, recipes and the recovery
// filler, through the real services, find only the program's team's songs and none for a program with no team.
describe("log, cue, recipe and recovery songs scoped to the program's team, against Postgres", () => {
  const team = 820_000 + (process.pid % 10_000);
  const other = team + 10_000;
  const prefix = `log-gate-${randomUUID()}`;
  const mine = `${prefix}-mine`;
  const orphan = `${prefix}-orphan`;
  const ids: Record<string, number> = {};
  const address = (name: string) => `https://media.test/${prefix}/${name}.mp3`;
  let prisma: PrismaService;
  let metrics: RadioMetricsService;

  type Flight = {
    programSongDb(
      path: 'generate',
      programId: string,
    ): Promise<PrismaService | null>;
    preflightClockItems(
      programId: string,
      items: unknown[],
    ): Promise<{ issues: string[] }>;
    executePlaySongCue(programId: string, cue: unknown): Promise<void>;
  };

  const flightOn = () =>
    Object.assign(Object.create(FlightService.prototype) as object, {
      prisma,
      metrics,
      pompeii: { teamId: team },
      refusedSongScopes: new Set<string>(),
      logger: { warn: jest.fn() },
      validateClockItems: () => undefined,
    }) as unknown as Flight;

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    metrics = new RadioMetricsService();
    for (const [name, owner] of [
      ['own', team],
      ['theirs', other],
    ] as const) {
      const song = await prisma.song.create({
        data: {
          artist: `${prefix}-${name}`,
          title: name,
          audioUrl: address(name),
          durationMs: 1000,
          teamId: owner,
        },
      });
      ids[name] = song.id;
    }
    for (const [programId, owner] of [
      [mine, team],
      [orphan, null],
    ] as const) {
      await prisma.program.create({ data: { programId, teamId: owner } });
    }
  });

  afterAll(async () => {
    await prisma?.program.deleteMany({
      where: { programId: { in: [mine, orphan] } },
    });
    await prisma?.song.deleteMany({
      where: { teamId: { in: [team, other] } },
    });
    await prisma?.$disconnect();
  });

  const found = async (path: 'generate', programId: string) => {
    const db = await flightOn().programSongDb(path, programId);
    return db
      ? (
          await db.song.findMany({
            where: { id: { in: [ids.own, ids.theirs] } },
          })
        ).map((song) => song.id)
      : [];
  };

  it("hands log generation the team's songs only", async () => {
    await expect(found('generate', mine)).resolves.toEqual([ids.own]);
    await expect(found('generate', orphan)).resolves.toEqual([]);
  });

  const cue = (name: string) => ({
    id: `cue-${name}`,
    kind: 'playSong',
    songId: ids[name],
  });

  it("validates a log's cues against the team's songs", async () => {
    const issues = async (programId: string, name: string) =>
      (await flightOn().preflightClockItems(programId, [cue(name)])).issues;
    await expect(issues(mine, 'own')).resolves.toEqual([]);
    await expect(issues(mine, 'theirs')).resolves.toEqual([
      'Item 1: song unavailable',
    ]);
    await expect(issues(orphan, 'own')).resolves.toEqual([
      'Item 1: song unavailable',
    ]);
  });

  it("refuses to run a cue for another team's song, or for a program with no team", async () => {
    for (const [programId, name] of [
      [mine, 'theirs'],
      [orphan, 'own'],
    ]) {
      await expect(
        flightOn().executePlaySongCue(programId, cue(name)),
      ).rejects.toThrow('scheduled song is unavailable');
    }
  });

  it("reads a recipe's song through the team", async () => {
    const issuesFor = async (programId: string, name: string) => {
      const recipes = Object.assign(
        Object.create(RecipesService.prototype) as object,
        {
          prisma,
          flights: flightOn(),
          metrics: { recordRecipeExpansion: jest.fn() },
        },
      ) as unknown as {
        build(...args: unknown[]): Promise<{ issues: unknown[] }>;
      };
      const built = await recipes.build(
        programId,
        1,
        {
          name: 'gate',
          steps: [],
          bumperSceneId: null,
          slideshowSceneId: null,
          returnSceneId: null,
          transitionId: 'cut',
          holdMs: 0,
        },
        ids[name],
        null,
        'use',
        undefined,
      );
      return built.issues.length;
    };
    const own = await issuesFor(mine, 'own');
    await expect(issuesFor(mine, 'theirs')).resolves.toBeGreaterThan(own);
    await expect(issuesFor(orphan, 'own')).resolves.toBeGreaterThan(own);
  });

  it("builds recovery filler from the team's songs only", async () => {
    const radio = Object.assign(
      Object.create(RadioService.prototype) as object,
      {
        prisma,
        metrics,
        pompeii: { teamId: team },
        logger: { warn: jest.fn() },
      },
    ) as unknown as {
      recoverySongDb(programId: string): Promise<PrismaService | null>;
    };
    const read = async (programId: string) => {
      const db = await radio.recoverySongDb(programId);
      return db
        ? (
            await db.song.findMany({
              where: { id: { in: [ids.own, ids.theirs] } },
            })
          ).map((song) => song.id)
        : [];
    };
    await expect(read(mine)).resolves.toEqual([ids.own]);
    await expect(read(orphan)).resolves.toEqual([]);
  });

  it('refuses a recovery playlist for a program with no team', async () => {
    const radio = Object.assign(
      Object.create(RadioService.prototype) as object,
      {
        prisma,
        metrics,
        pompeii: { teamId: team },
        logger: { warn: jest.fn() },
        programRadioFillerVersion: async () => null,
        requireRadioSettings: async () => ({}),
      },
    ) as unknown as RadioService;
    await expect(
      radio.prepareRecoveryPlaylist(orphan, [ids.own]),
    ).rejects.toThrow('every recovery song must be enabled');
    await expect(
      radio.prepareRecoveryPlaylist(mine, [ids.theirs]),
    ).rejects.toThrow('every recovery song must be enabled');
  });

  it('counts every refusal and ignores a path it does not know', async () => {
    metrics.recordLogSongScopeRefusal('nonsense' as never);
    const rendered = metrics.render();
    for (const path of ['generate', 'validate', 'recipe', 'recovery']) {
      expect(rendered).toMatch(
        new RegExp(
          `alcantara_log_song_scope_refusals_total\\{path="${path}"\\} [1-9]`,
        ),
      );
    }
    expect(rendered).not.toMatch('nonsense');
  });
});
