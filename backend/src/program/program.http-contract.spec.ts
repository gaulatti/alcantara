import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { of } from 'rxjs';
import { ProgramController } from './program.controller';
import { ProgramService } from './program.service';
import { FlightService } from './flight.service';
import { ProgramTemplateService } from './program-template.service';

// This isolates the HTTP controller contract. The full AppModule end-to-end
// suites separately exercise real authentication, authorization and persistence.
const programMethods = [
  'listPrograms',
  'createProgram',
  'renameProgram',
  'deleteProgram',
  'getBroadcastSettings',
  'updateBroadcastSettings',
  'getPublicState',
  'getState',
  'getProgramAudioBus',
  'getProgramAudioMeter',
  'updateProgramAudioMeter',
  'getProgramSceneInstantPlayback',
  'takeProgramSceneInstant',
  'stopProgramSceneInstant',
  'getProgramSongPlayback',
  'enqueueProgramSong',
  'reorderProgramSongQueue',
  'removeQueuedProgramSong',
  'updateProgramSongPlayback',
  'proxyAudio',
  'addSceneToProgram',
  'removeSceneFromProgram',
  'listProgramMediaGroups',
  'addMediaGroupToProgram',
  'removeMediaGroupFromProgram',
  'listProgramStingers',
  'addStingerToProgram',
  'removeStingerFromProgram',
  'activateScene',
  'getStagedScene',
  'stageScene',
  'setFadeToBlack',
  'takeProgramOffAir',
  'takeProgramSongOffAir',
  'requestProgramReload',
  'updateProgramAudioBus',
  'getEventStream',
];
const flightMethods = [
  'listFlightSequences',
  'createFlightSequence',
  'updateFlightSequence',
  'generateTaggedLog',
  'fillRundown',
  'preflightFlightSequence',
  'publishFlightSequence',
  'deleteFlightSequence',
  'activateFlightSequence',
  'deactivateFlightSequence',
  'start',
  'stop',
  'go',
  'reset',
];
const mocks = (names: string[]) =>
  Object.fromEntries(
    names.map((name) => [name, jest.fn().mockResolvedValue({ via: name })]),
  );

describe('ProgramController native Fastify HTTP contract', () => {
  let app: NestFastifyApplication;
  let liveUrl: string | undefined;
  const program = mocks(programMethods);
  const flight = mocks(flightMethods);
  const registration = {
    templateUrl: 'https://templates.example/manifest.json',
    templateManifest: {
      kind: 'alcantara.program-template',
      contractVersion: 1,
      id: 'example',
    },
    templateVerifiedAt: new Date('2026-01-01T00:00:00Z'),
  };
  const templates = { inspect: jest.fn().mockResolvedValue(registration) };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ProgramController],
      providers: [
        { provide: ProgramService, useValue: program },
        { provide: FlightService, useValue: flight },
        { provide: ProgramTemplateService, useValue: templates },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
      { logger: ['error'] },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => app?.close());

  it.each([
    { path: '/program', service: 'listPrograms', args: [] },
    {
      path: '/program/broadcast-settings',
      service: 'getBroadcastSettings',
      args: [],
    },
    { path: '/program/state', service: 'getState', args: [] },
    { path: '/program/news/state', service: 'getPublicState', args: ['news'] },
    {
      path: '/program/news/audio-bus',
      service: 'getProgramAudioBus',
      args: ['news'],
    },
    {
      path: '/program/news/audio-meter',
      service: 'getProgramAudioMeter',
      args: ['news'],
    },
    {
      path: '/program/news/scene-instant',
      service: 'getProgramSceneInstantPlayback',
      args: ['news'],
    },
    {
      path: '/program/news/song-playback',
      service: 'getProgramSongPlayback',
      args: ['news'],
    },
    {
      path: '/program/news/media-groups',
      service: 'listProgramMediaGroups',
      args: ['news'],
    },
    {
      path: '/program/news/stingers',
      service: 'listProgramStingers',
      args: ['news'],
    },
    { path: '/program/news/stage', service: 'getStagedScene', args: ['news'] },
  ])(
    'serves the exact HTTP read contract $path',
    async ({ path, service, args }) => {
      const response = await app.inject({ method: 'GET', url: path });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ via: service });
      expect(program[service]).toHaveBeenCalledWith(...args);
    },
  );

  it.each([
    {
      method: 'POST',
      path: '/program/news/audio-meter',
      body: { main: 0.5 },
      service: 'updateProgramAudioMeter',
      args: [{ main: 0.5 }, 'news'],
    },
    {
      method: 'POST',
      path: '/program/news/song-playback',
      body: { token: 'renderer', progress: 0.5 },
      service: 'updateProgramSongPlayback',
      args: [{ token: 'renderer', progress: 0.5 }, 'news'],
    },
    {
      method: 'POST',
      path: '/program/news/scene-instant/stop',
      body: {},
      service: 'stopProgramSceneInstant',
      args: ['news'],
    },
    {
      method: 'POST',
      path: '/program/news/scenes',
      body: { sceneId: 7 },
      service: 'addSceneToProgram',
      args: [7, 'news'],
    },
    {
      method: 'DELETE',
      path: '/program/news/scenes/7',
      service: 'removeSceneFromProgram',
      args: [7, 'news'],
    },
    {
      method: 'POST',
      path: '/program/news/media-groups',
      body: { mediaGroupId: 8 },
      service: 'addMediaGroupToProgram',
      args: [8, 'news'],
    },
    {
      method: 'DELETE',
      path: '/program/news/media-groups/8',
      service: 'removeMediaGroupFromProgram',
      args: [8, 'news'],
    },
    {
      method: 'POST',
      path: '/program/news/stingers',
      body: { stingerId: 9 },
      service: 'addStingerToProgram',
      args: [9, 'news'],
    },
    {
      method: 'DELETE',
      path: '/program/news/stingers/9',
      service: 'removeStingerFromProgram',
      args: [9, 'news'],
    },
    {
      method: 'POST',
      path: '/program/news/activate',
      body: { sceneId: 7, transitionId: 'fade' },
      service: 'activateScene',
      args: [7, 'news', 'fade'],
    },
    {
      method: 'POST',
      path: '/program/activate',
      body: { sceneId: 7 },
      service: 'activateScene',
      args: [7, undefined, undefined],
    },
    {
      method: 'POST',
      path: '/program/news/off-air',
      body: {},
      service: 'takeProgramOffAir',
      args: ['news'],
    },
    {
      method: 'POST',
      path: '/program/off-air',
      body: {},
      service: 'takeProgramOffAir',
      args: [],
    },
    {
      method: 'POST',
      path: '/program/news/song/off-air',
      body: {},
      service: 'takeProgramSongOffAir',
      args: ['news'],
    },
    {
      method: 'POST',
      path: '/program/song/off-air',
      body: {},
      service: 'takeProgramSongOffAir',
      args: [],
    },
    {
      method: 'POST',
      path: '/program/news/reload',
      body: {},
      service: 'requestProgramReload',
      args: ['news'],
    },
    {
      method: 'POST',
      path: '/program/reload',
      body: {},
      service: 'requestProgramReload',
      args: [],
    },
    {
      method: 'PUT',
      path: '/program/news/audio-bus',
      body: { mixerSettings: { main: 1 } },
      service: 'updateProgramAudioBus',
      args: [{ mixerSettings: { main: 1 } }, 'news'],
    },
    {
      method: 'PUT',
      path: '/program/broadcast-settings',
      body: { enabled: false },
      service: 'updateBroadcastSettings',
      args: [{ enabled: false }],
    },
    {
      method: 'DELETE',
      path: '/program/news',
      service: 'deleteProgram',
      args: ['news'],
    },
    {
      method: 'DELETE',
      path: '/program/news/song-queue/entry%3A1',
      service: 'removeQueuedProgramSong',
      args: ['news', 'entry:1'],
    },
  ])(
    'preserves HTTP operation and typed route/body identity for $method $path',
    async ({ method, path, body, service, args }) => {
      const response = await app.inject({
        method: method as any,
        url: path,
        ...(body ? { payload: body } : {}),
      });
      expect(response.statusCode).toBe(method === 'POST' ? 201 : 200);
      expect(response.json()).toEqual({ via: service });
      expect(program[service]).toHaveBeenCalledWith(...args);
    },
  );

  it.each([
    {
      body: { sceneId: 7, instantId: 8, mediaAssetId: ' media:1 ' },
      args: [7, 'news', 8, 'media:1'],
    },
    {
      body: { sceneId: '7', instantId: '8', mediaAssetId: ' ' },
      args: [null, 'news', null, null],
    },
    { body: {}, args: [null, 'news', null, null] },
  ])(
    'normalizes scene-instant request identities without coercing strings into numeric authority: $body',
    async ({ body, args }) => {
      const response = await app.inject({
        method: 'POST',
        url: '/program/news/scene-instant/take',
        payload: body,
      });
      expect(response.statusCode).toBe(201);
      expect(program.takeProgramSceneInstant).toHaveBeenCalledWith(...args);
    },
  );

  it.each([{ sceneId: 7 }, { sceneId: '7' }, {}])(
    'normalizes staged-scene numeric identity through the actual HTTP endpoint: %p',
    async (body) => {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/program/news/stage',
            payload: body,
          })
        ).statusCode,
      ).toBe(201);
      expect(program.stageScene).toHaveBeenCalledWith(
        typeof body.sceneId === 'number' ? 7 : null,
        'news',
      );
    },
  );

  it.each([{ active: true }, { active: false }, { active: 'true' }, {}])(
    'accepts only an explicit boolean fade-to-black flag: %p',
    async (body) => {
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/program/news/fade-to-black',
            payload: body,
          })
        ).statusCode,
      ).toBe(200);
      expect(program.setFadeToBlack).toHaveBeenCalledWith(
        body.active === true,
        'news',
      );
    },
  );

  it('decodes the audio proxy URL and streams the native bytes/content type with inline disposition', async () => {
    const buffer = Buffer.from([0, 1, 2, 255]);
    program.proxyAudio.mockResolvedValueOnce({
      buffer,
      contentType: 'audio/mpeg',
    });
    const url = 'https://media.example/a.mp3?part=1';
    const response = await app.inject({
      method: 'GET',
      url: `/program/audio-proxy?url=${encodeURIComponent(url)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(buffer);
    expect(response.headers['content-type']).toBe('audio/mpeg');
    expect(response.headers['content-disposition']).toBe('inline');
    expect(program.proxyAudio).toHaveBeenCalledWith(url);
  });

  it('does not swallow service validation failures or publish a success-shaped response', async () => {
    program.stageScene.mockRejectedValueOnce(
      new BadRequestException('Invalid staged scene'),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/program/news/stage',
      payload: { sceneId: -1 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ message: 'Invalid staged scene' });
  });

  it.each([{ itemId: 'song-1' }, { itemId: 7 }, {}])(
    'preserves queue item identity or passes the explicit missing-item sentinel: %p',
    async (body) => {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/program/news/song-queue',
            payload: body,
          })
        ).statusCode,
      ).toBe(201);
      expect(program.enqueueProgramSong).toHaveBeenCalledWith(
        'news',
        typeof body.itemId === 'string' ? body.itemId : '',
      );
    },
  );
  it.each([{ entryIds: ['entry-1'] }, { entryIds: 'entry-1' }, {}])(
    'requires a queue order array at the HTTP boundary: %p',
    async (body) => {
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/program/news/song-queue',
            payload: body,
          })
        ).statusCode,
      ).toBe(200);
      expect(program.reorderProgramSongQueue).toHaveBeenCalledWith(
        'news',
        Array.isArray(body.entryIds) ? body.entryIds : [],
      );
    },
  );

  it.each([
    {
      method: 'GET',
      path: '/program/news/flight',
      service: 'listFlightSequences',
      args: ['news'],
    },
    {
      method: 'POST',
      path: '/program/news/flight',
      body: { name: 'Hour', items: [], loop: false },
      service: 'createFlightSequence',
      args: ['news', { name: 'Hour', items: [], loop: false }],
    },
    {
      method: 'PUT',
      path: '/program/news/flight/17',
      body: { revision: 3, name: 'Renamed' },
      service: 'updateFlightSequence',
      args: ['news', 17, { revision: 3, name: 'Renamed' }],
    },
    {
      method: 'POST',
      path: '/program/news/flight/17/generate',
      body: { revision: 3, rules: [] },
      service: 'generateTaggedLog',
      args: ['news', 17, { revision: 3, rules: [] }],
    },
    {
      method: 'POST',
      path: '/program/news/flight/17/fill',
      body: { revision: 3, items: [] },
      service: 'fillRundown',
      args: ['news', 17, { revision: 3, items: [] }],
    },
    {
      method: 'GET',
      path: '/program/news/flight/17/preflight',
      service: 'preflightFlightSequence',
      args: ['news', 17],
    },
    {
      method: 'POST',
      path: '/program/news/flight/17/publish',
      body: { revision: 3 },
      service: 'publishFlightSequence',
      args: ['news', 17, 3],
    },
    {
      method: 'DELETE',
      path: '/program/news/flight/17',
      service: 'deleteFlightSequence',
      args: ['news', 17],
    },
    {
      method: 'POST',
      path: '/program/news/flight/17/activate',
      body: {},
      service: 'activateFlightSequence',
      args: ['news', 17],
    },
    {
      method: 'POST',
      path: '/program/news/flight/deactivate',
      body: {},
      service: 'deactivateFlightSequence',
      args: ['news'],
    },
    {
      method: 'POST',
      path: '/program/news/flight/start',
      body: {},
      service: 'start',
      args: ['news'],
    },
    {
      method: 'POST',
      path: '/program/news/flight/stop',
      body: {},
      service: 'stop',
      args: ['news'],
    },
    {
      method: 'POST',
      path: '/program/news/flight/go',
      body: {},
      service: 'go',
      args: ['news'],
    },
    {
      method: 'POST',
      path: '/program/news/flight/reset',
      body: {},
      service: 'reset',
      args: ['news'],
    },
  ])(
    'preserves exact Flight scope, numeric sequence id and optimistic revision for $method $path',
    async ({ method, path, body, service, args }) => {
      const response = await app.inject({
        method: method as any,
        url: path,
        ...(body ? { payload: body } : {}),
      });
      expect(response.statusCode).toBe(method === 'POST' ? 201 : 200);
      expect(response.json()).toEqual({ via: service });
      expect(flight[service]).toHaveBeenCalledWith(...args);
    },
  );

  it('inspects a bounded nonempty template and rejects missing template inspection input', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/program/template/inspect',
          payload: { templateUrl: registration.templateUrl },
        })
      ).statusCode,
    ).toBe(201);
    expect(templates.inspect).toHaveBeenCalledWith(registration.templateUrl);
    for (const payload of [{}, { templateUrl: ' ' }, { templateUrl: 7 }])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/program/template/inspect',
            payload,
          })
        ).statusCode,
      ).toBe(400);
  });

  it('creates and renames programs with explicit template registration/clearing and rejects visual templates on radio', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/program',
          payload: {
            programId: 'news',
            type: 'tv',
            templateUrl: registration.templateUrl,
          },
        })
      ).statusCode,
    ).toBe(201);
    expect(program.createProgram).toHaveBeenCalledWith(
      'news',
      'tv',
      registration,
    );
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/program/news',
          payload: { nextProgramId: 'new-news', templateUrl: '' },
        })
      ).statusCode,
    ).toBe(200);
    expect(program.renameProgram).toHaveBeenCalledWith(
      'news',
      'new-news',
      undefined,
      null,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/program',
          payload: { programId: 'radio', type: 'radio' },
        })
      ).statusCode,
    ).toBe(201);
    expect(program.createProgram).toHaveBeenLastCalledWith(
      'radio',
      'radio',
      undefined,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/program',
          payload: {
            programId: 'radio',
            type: 'radio',
            templateUrl: registration.templateUrl,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(program.createProgram).toHaveBeenCalledTimes(2);
  });

  it.each([
    { path: '/program/news/events', args: ['news'] },
    { path: '/program/events', args: [] },
  ])(
    'serializes the SSE initial payload and disables proxy buffering for $path',
    async ({ path, args }) => {
      program.getEventStream.mockReturnValueOnce(
        of({ data: JSON.stringify({ type: 'state', programId: 'news' }) }),
      );
      // SSE requires a real Node socket; Fastify inject supplies a synthetic
      // socket without setKeepAlive, which is not a usable SSE transport.
      if (!liveUrl) {
        await app.listen(0, '127.0.0.1');
        liveUrl = await app.getUrl();
      }
      const response = await fetch(liveUrl + path, {
        signal: AbortSignal.timeout(3000),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(
        'text/event-stream',
      );
      expect(
        new Set(
          response.headers
            .get('x-accel-buffering')
            ?.split(',')
            .map((value) => value.trim()),
        ),
      ).toEqual(new Set(['no']));
      expect(await response.text()).toContain(
        'data: {"type":"state","programId":"news"}',
      );
      expect(program.getEventStream).toHaveBeenCalledWith(...args);
    },
  );
});
