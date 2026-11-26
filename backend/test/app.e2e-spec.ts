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
import { ProgramService } from './../src/program/program.service';
import { NowPlayingPublisherService } from './../src/radio/now-playing-publisher.service';
import { PlayoutSongScope } from './../src/radio/playout-song-scope';
import { RadioService } from './../src/radio/radio.service';
import { SongExecutionEngine } from './../src/radio/song-execution.engine';
import { SceneAssetScope } from './../src/program/scene-asset-scope';

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

  it('gives the program service the scene asset scope', () => {
    const programs = app.get(ProgramService) as unknown as {
      sceneAssets?: unknown;
    };
    expect(programs.sceneAssets).toBe(app.get(SceneAssetScope));
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });
});
