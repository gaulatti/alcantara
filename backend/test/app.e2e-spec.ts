// music-metadata is ESM-only; the uploads module loads it, so the unit specs mock it the same way
// (gaulatti/alcantara#331). Nothing here uploads audio.
jest.mock('music-metadata', () => ({ parseBuffer: jest.fn() }), {
  virtual: true,
});

import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import { listenOnLoopback } from './loopback-supertest';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma.service';
import { ProgramService } from './../src/program/program.service';
import { NowPlayingPublisherService } from './../src/radio/now-playing-publisher.service';
import { PlayoutSongScope } from './../src/radio/playout-song-scope';
import { RadioService } from './../src/radio/radio.service';
import { SongExecutionEngine } from './../src/radio/song-execution.engine';

describe('AppController (e2e)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // The HTTP metrics hook needs the Fastify adapter (the app's own, gaulatti/alcantara#331).
    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await listenOnLoopback(app.getHttpServer());
  });

  // Without this the open database pool and the app's timers keep Jest alive after the run.
  afterEach(async () => {
    await app.close();
  });

  // The scope is an optional dependency, so a wiring mistake would not fail start-up (gaulatti/alcantara#122).
  it('gives the playout song scope to all four services that read songs on air', () => {
    const scope = app.get(PlayoutSongScope);
    for (const service of [
      RadioService,
      SongExecutionEngine,
      NowPlayingPublisherService,
      ProgramService,
    ]) {
      expect(
        (app.get(service) as unknown as { songScope?: unknown }).songScope,
      ).toBe(scope);
    }
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });
});

// gaulatti/alcantara#122: the program team guard must run after authentication, which sets the caller's team. Booted
// through the real application, so a change of module or guard order fails here.
describe('program routes and the caller team (e2e)', () => {
  const environment = { ...process.env };
  const programId = `app-e2e-${process.pid}`;
  const team = 920_000 + (process.pid % 10_000);
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.AUTH_MODE = 'test';
    process.env.TEST_AUTH_SECRET = 'test-secret-test-secret-test-secret-00';
    process.env.POMPEII_TEAM_ID = String(team);
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await app.get(PrismaService).program.create({
      data: { programId, teamId: team + 1 },
    });
  });

  afterAll(async () => {
    await app?.get(PrismaService).program.deleteMany({ where: { programId } });
    await app?.close();
    process.env = environment;
  });

  it("answers 404 for another team's program", async () => {
    const session = await app.inject({ method: 'GET', url: '/__test/session' });
    const { accessToken } = session.json<{ accessToken: string }>();
    const answer = await app.inject({
      method: 'GET',
      url: `/program/${programId}/stage`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(answer.statusCode).toBe(404);
  });
});
