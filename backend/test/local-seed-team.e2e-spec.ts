import { PrismaService } from '../src/prisma.service';
import { RadioMetricsService } from '../src/radio/radio-metrics.service';
import { FlightService } from '../src/program/flight.service';
import { DEMO_SONG_IDS } from '../src/seed/demo-audio';
import { seedLocalDatabase } from '../prisma/seed';

// The airing walk's W2 against real PostgreSQL with the committed migrations applied: the local backend runs with
// POMPEII_TEAM_ID set, and song reads go through the caller's or the program's team (gaulatti/alcantara#122). A fresh
// stack's seed must give its library rows and its shows that team, or the library is empty and Check refuses every
// song as unavailable. The media store is a fake that accepts the demo tones; nothing leaves the test.

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const TEAM = 1;

describeWithDatabase('the local seed and team-scoped reads (PostgreSQL e2e)', () => {
  let prisma: PrismaService;
  const uploads: unknown[] = [];
  const environment = {
    NODE_ENV: 'development',
    POMPEII_TEAM_ID: String(TEAM),
    MEDIA_S3_BUCKET: 'alcantara-local-only',
    MEDIA_S3_ENDPOINT: 'http://localstack.localhost:4566',
    LOCAL_MEDIA_PUBLIC_BASE_URL: 'http://localstack.localhost:4566/alcantara-local-only',
  };
  const fakeStore = {
    send: async (command: unknown) => {
      uploads.push(command);
      return {};
    },
  } as unknown as Parameters<typeof seedLocalDatabase>[2];

  const flight = () =>
    Object.assign(Object.create(FlightService.prototype) as object, {
      prisma,
      metrics: new RadioMetricsService(),
      pompeii: { teamId: TEAM },
      refusedSongScopes: new Set<string>(),
      logger: { warn: jest.fn(), log: jest.fn() },
      validateClockItems: () => undefined,
    }) as unknown as {
      preflightClockItems(
        programId: string,
        items: unknown[],
      ): Promise<{ ready: boolean; issues: string[] }>;
    };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await seedLocalDatabase(prisma, environment, fakeStore);
  }, 60_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await prisma?.$disconnect();
  });

  it('gives every seeded show and library row the local team', async () => {
    expect(uploads).toHaveLength(DEMO_SONG_IDS.length);
    const shows = await prisma.program.findMany({
      where: { programId: { in: ['main', 'tv-demo', 'radio-demo'] } },
      select: { programId: true, teamId: true },
      orderBy: { programId: 'asc' },
    });
    expect(shows).toEqual([
      { programId: 'main', teamId: TEAM },
      { programId: 'radio-demo', teamId: TEAM },
      { programId: 'tv-demo', teamId: TEAM },
    ]);
    const songs = await prisma.song.findMany({
      where: { id: { in: [9001, 9002, ...DEMO_SONG_IDS] } },
      select: { teamId: true, assetId: true },
    });
    expect(songs).toHaveLength(2 + DEMO_SONG_IDS.length);
    expect(songs.every((song) => song.teamId === TEAM)).toBe(true);
    const assets = await prisma.mediaAsset.findMany({
      where: { id: { in: songs.map((song) => song.assetId!) } },
      select: { teamId: true },
    });
    expect(assets).toHaveLength(songs.length);
    expect(assets.every((asset) => asset.teamId === TEAM)).toBe(true);
    for (const [model, where] of [
      ['instant', { id: { in: [9001, 9002] } }],
      ['scene', { id: { in: [9001, 9002] } }],
      ['media', { id: 9001 }],
      ['stinger', { id: 9001 }],
      ['mediaLabel', { name: 'Demo music' }],
    ] as const) {
      const rows = await (
        prisma[model] as unknown as {
          findMany(args: unknown): Promise<{ teamId: number | null }[]>;
        }
      ).findMany({ where, select: { teamId: true } });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.teamId === TEAM)).toBe(true);
    }
  });

  it("passes Check for a block of the seeded radio show's songs", async () => {
    const items = DEMO_SONG_IDS.slice(0, 3).map((songId, index) => ({
      id: `seed-check-${index}`,
      kind: 'playSong',
      songId,
      ...(index === 0 ? { clockOffsetSeconds: 0 } : {}),
    }));
    const result = await flight().preflightClockItems('radio-demo', items);
    expect(result.issues).toEqual([]);
    expect(result.ready).toBe(true);
  });

  it('is repeatable: a second run changes nothing it already wrote', async () => {
    await seedLocalDatabase(prisma, environment, fakeStore);
    const show = await prisma.program.findUnique({
      where: { programId: 'radio-demo' },
      select: { teamId: true },
    });
    expect(show?.teamId).toBe(TEAM);
  });
});
