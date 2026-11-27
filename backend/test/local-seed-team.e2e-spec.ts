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

  it("gives the seeded radio show's 24/7 rotation Loop on for a fresh seed", async () => {
    const radio = await prisma.programState.findUniqueOrThrow({
      where: { programId: 'radio-demo' },
      select: { songSequence: true },
    });
    expect((radio.songSequence as { loop?: boolean }).loop).toBe(true);
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
    // An operator's local changes survive the re-seed that runs on every backend start (the recovery walk).
    const radio = await prisma.programState.findUniqueOrThrow({
      where: { programId: 'radio-demo' },
      select: { id: true },
    });
    await prisma.radioSettings.update({
      where: { programStateId: radio.id },
      data: { enabled: true },
    });
    const key = {
      subject_deviceClass: {
        subject: 'test:alcantara:operator-a',
        deviceClass: 'desktop',
      },
    };
    const preference = await prisma.operatorPreference.findUniqueOrThrow({
      where: key,
    });
    await prisma.operatorPreference.update({
      where: key,
      data: {
        version: preference.version + 1,
        profile: { ...(preference.profile as object), selectedProgramId: 'radio-demo' },
      },
    });
    await seedLocalDatabase(prisma, environment, fakeStore);
    expect(
      (
        await prisma.radioSettings.findUniqueOrThrow({
          where: { programStateId: radio.id },
        })
      ).enabled,
    ).toBe(true);
    const after = await prisma.operatorPreference.findUniqueOrThrow({
      where: key,
    });
    expect(after.version).toBe(preference.version + 1);
    expect((after.profile as { selectedProgramId: string }).selectedProgramId).toBe(
      'radio-demo',
    );
    const show = await prisma.program.findUnique({
      where: { programId: 'radio-demo' },
      select: { teamId: true },
    });
    expect(show?.teamId).toBe(TEAM);
  });

  it('keeps what an operator changed to the seeded shows through a re-seed', async () => {
    // A backend restart re-runs the seed. The rotation, show type, mixer, on-air scene and log pointer an operator
    // set must come through it (Yakko's #800 review). The values are put back afterwards, so other specs that read
    // these shows see them as the seed left them.
    const read = (programId: string) =>
      prisma.programState.findUniqueOrThrow({
        where: { programId },
        select: {
          id: true,
          type: true,
          songSequence: true,
          audioMixer: true,
          activeSceneId: true,
          activeFlightSequenceId: true,
        },
      });
    const before = {
      main: await read('main'),
      tv: await read('tv-demo'),
      radio: await read('radio-demo'),
    };
    const operatorMixer = { operatorChange: 'mixer', channels: [] };
    try {
      await prisma.programState.update({
        where: { programId: 'main' },
        data: {
          type: 'tv',
          songSequence: { ...(before.main.songSequence as object), mode: 'shuffle' },
        },
      });
      await prisma.programState.update({
        where: { programId: 'tv-demo' },
        // Taken off air: no scene on air, and the operator's mixer.
        data: { activeSceneId: null, audioMixer: operatorMixer as never },
      });
      await prisma.programState.update({
        where: { programId: 'radio-demo' },
        data: { activeFlightSequenceId: null },
      });

      await seedLocalDatabase(prisma, environment, fakeStore);

      const after = {
        main: await read('main'),
        tv: await read('tv-demo'),
        radio: await read('radio-demo'),
      };
      expect(after.main.type).toBe('tv');
      expect((after.main.songSequence as { mode: string }).mode).toBe('shuffle');
      expect(after.tv.audioMixer).toEqual(operatorMixer);
      expect(after.tv.activeSceneId).toBeNull();
      expect(after.radio.activeFlightSequenceId).toBeNull();
    } finally {
      for (const [programId, original] of [
        ['main', before.main],
        ['tv-demo', before.tv],
        ['radio-demo', before.radio],
      ] as const) {
        await prisma.programState.update({
          where: { programId },
          data: {
            type: original.type,
            songSequence: original.songSequence as never,
            audioMixer: original.audioMixer as never,
            activeSceneId: original.activeSceneId,
            activeFlightSequenceId: original.activeFlightSequenceId,
          },
        });
      }
    }
  });
});
