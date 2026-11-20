jest.mock('music-metadata', () => ({ parseBuffer: jest.fn() }), {
  virtual: true,
});

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { DEPLOY_CANDIDATE_ENV } from '../src/config/deploy-candidate';
import { PrismaService } from '../src/prisma.service';
import { SongExecutionEngine } from '../src/radio/song-execution.engine';

// gaulatti/alcantara#223 against real PostgreSQL with the committed
// migrations applied: the whole application boots in deploy candidate mode
// and answers, PostgreSQL refuses any write it attempts, and with the timers
// given time to fire (the rundown poll runs every second) no rundown block is
// reset or started and no row changes.

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase('deploy candidate (PostgreSQL e2e)', () => {
  const programId = `e2e-candidate-${randomUUID()}`;
  let seed: PrismaService;
  let app: INestApplication<App>;
  let running: number;
  let due: number;
  const snapshot = () =>
    seed.flightSequence.findMany({
      where: { id: { in: [running, due] } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        isRunning: true,
        lastStartedAt: true,
        revision: true,
        updatedAt: true,
      },
    });
  let before: Awaited<ReturnType<typeof snapshot>>;
  let programStates: number;
  const radioSnapshot = async () => ({
    state: await seed.programState.findUnique({
      where: { programId },
      include: { radioSettings: true },
    }),
    asRun: await seed.asRunRecord.count(),
  });
  let radioBefore: Awaited<ReturnType<typeof radioSnapshot>>;

  beforeAll(async () => {
    // The seeding client is built before the setting is on: a normal one.
    seed = new PrismaService();
    await seed.$connect();
    // Production is always mid-song: an enabled radio program in autoplay with
    // a song on air, an active queue entry and a filler set, which the song
    // engine loads at start-up. Its Palazzo address answers nothing.
    const song = (n: number) => ({
      id: `e2e-song-${n}`,
      kind: 'song',
      title: `Fictional song ${n}`,
      artist: 'Fictional artist',
      audioUrl: `https://media.example/e2e-${n}.mp3`,
      durationMs: 180_000,
    });
    const state = await seed.programState.create({
      data: {
        programId,
        type: 'radio',
        songSequence: {
          mode: 'autoplay',
          items: [song(1), song(2), song(3)],
          activeItemId: 'e2e-song-1',
          loop: true,
          startedAt: Date.now() - 60_000,
        },
        songQueue: [
          {
            id: 'e2e-queue-1',
            itemId: 'e2e-song-2',
            enqueuedAt: Date.now() - 30_000,
            active: true,
            playbackRequestId: 'e2e-playback-1',
          },
          { id: 'e2e-queue-2', itemId: 'e2e-song-3', enqueuedAt: Date.now() },
        ],
        radioSettings: {
          create: {
            enabled: true,
            palazzoUrl: 'http://127.0.0.1:1',
            fillerSongIds: [1, 2],
            fillerVersion: 'e2e-filler-1',
          },
        },
      },
    });
    const minute = 60_000;
    // A block that was running when the live instance last started, which a
    // normal start marks as not running...
    running = (
      await seed.flightSequence.create({
        data: {
          programStateId: state.id,
          name: 'running',
          items: [],
          isRunning: true,
          scheduledAt: new Date(Date.now() - 10 * minute),
          publishedAt: new Date(Date.now() - 20 * minute),
          lastStartedAt: new Date(Date.now() - 10 * minute),
        },
      })
    ).id;
    // ...and a published block that is due now, which the one-second poll of
    // a normal instance would claim and start.
    due = (
      await seed.flightSequence.create({
        data: {
          programStateId: state.id,
          name: 'due',
          items: [],
          scheduledAt: new Date(Date.now() - 1000),
          publishedAt: new Date(Date.now() - 5 * minute),
        },
      })
    ).id;
    before = await snapshot();
    programStates = await seed.programState.count();
    radioBefore = await radioSnapshot();

    process.env[DEPLOY_CANDIDATE_ENV] = '1';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    delete process.env[DEPLOY_CANDIDATE_ENV];
    await seed.programState.deleteMany({ where: { programId } });
    await seed.$disconnect();
  });

  it('answers the health check', async () => {
    await request(app.getHttpServer()).get('/').expect(200);
  });

  it('cannot write: PostgreSQL refuses it', async () => {
    const candidate = app.get(PrismaService);
    await expect(
      candidate.flightSequence.update({
        where: { id: running },
        data: { isRunning: false },
      }),
    ).rejects.toThrow(/read-only transaction/);
    await expect(
      candidate.$executeRawUnsafe(
        'UPDATE "FlightSequence" SET "isRunning" = false WHERE id = $1',
        running,
      ),
    ).rejects.toThrow(/read-only transaction/);
  });

  it('resets, claims and starts nothing while its timers fire', async () => {
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(await snapshot()).toEqual(before);
    expect(await seed.programState.count()).toBe(programStates);
  });

  it('loads a mid-song radio program without writing to it', async () => {
    // The engine read the program at start-up (its state is in memory)...
    const engine = app.get(SongExecutionEngine) as unknown as {
      radioProgramIds: Set<string>;
    };
    expect(engine.radioProgramIds.has(programId)).toBe(true);
    await request(app.getHttpServer()).get('/').expect(200);
    // ...and nothing about the program, its settings or the as-run log moved.
    expect(await radioSnapshot()).toEqual(radioBefore);
  });
});
