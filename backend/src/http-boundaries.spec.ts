import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { RadioController } from './radio/radio.controller';
import { RadioService } from './radio/radio.service';
import { SongExecutionEngine } from './radio/song-execution.engine';
import { NowPlayingPublisherService } from './radio/now-playing-publisher.service';
import { PalazzoRadioTelemetryService } from './radio/palazzo-telemetry.service';
import { RadioOutputConfidenceService } from './radio/radio-output-confidence.service';
import { WebrtcController } from './webrtc/webrtc.controller';
import { WebrtcService } from './webrtc/webrtc.service';
import { MediaAssetsController } from './media-assets/media-assets.controller';
import { MediaAssetsService } from './media-assets/media-assets.service';
import { ScenesController } from './scenes/scenes.controller';
import { ScenesService } from './scenes/scenes.service';
import { InstantsController } from './instants/instants.controller';
import { ProgramService } from './program/program.service';
import { ExternalSourcesController } from './external-sources/external-sources.controller';
import { ExternalSourcesService } from './external-sources/external-sources.service';
import { ExternalSourceMetricsInterceptor } from './external-sources/external-source-metrics.interceptor';
import { ManagedMetricsService } from './observability/managed-metrics.service';

// These tests isolate the native HTTP contract and assume an already resolved
// request identity. AppModule e2e tests separately verify real authorization.
const fixture = { id: 'fixture-response', nested: { preserved: true } };
const authorization = { permissions: ['fixture-permission'] };
const identity = {
  subject: 'fixture-subject',
  principalId: 'fixture-principal',
};
const mocks = (names: string[]) =>
  Object.fromEntries(names.map((name) => [name, jest.fn()]));

describe('controller contracts through native Fastify HTTP routing', () => {
  let app: NestFastifyApplication;
  const radio = mocks([
    'getRadioSettings',
    'updateRadioSettings',
    'getRecoveryStatus',
    'prepareRecoveryPlaylist',
    'setRecoveryAutomation',
    'stopSong',
    'playInstant',
    'stopAllInstants',
    'getPalazzoStatus',
  ]);
  const engine = mocks(['handleManualSong', 'handleStopSong']);
  const publisher = mocks(['listConsumers', 'replaceConsumers']);
  const telemetry = mocks(['handleRadioSettingsChanged', 'getStatus']);
  const confidence = mocks(['get']);
  const webrtc = mocks([
    'getPublicConfig',
    'listInvitations',
    'createInvitation',
    'replaceInvitation',
    'revokeInvitation',
    'updateReturn',
    'redeemInvitation',
    'heartbeat',
    'acknowledgeCommand',
    'listParticipants',
    'createOperatorToken',
    'controlParticipant',
    'removeParticipant',
    'createRendererToken',
    'getRendererState',
    'createRendererSourceToken',
  ]);
  const assets = mocks([
    'findAll',
    'findOne',
    'createBackgroundAudio',
    'removeStandaloneAsset',
    'replaceAssetLabels',
    'findLabels',
    'resolveLabelImages',
    'findLabel',
    'createLabel',
    'updateLabel',
    'replaceLabelAssets',
    'removeLabel',
  ]);
  const scenes = mocks([
    'findAll',
    'findOne',
    'create',
    'update',
    'updateChyron',
    'drawModoItalianoBracket',
    'voteModoItalianoBracket',
    'openModoItalianoBracketVoting',
    'remove',
  ]);
  const program = mocks([
    'listInstants',
    'createInstant',
    'updateInstant',
    'deleteInstant',
    'playInstant',
    'stopAllInstants',
  ]);
  const sources = mocks([
    'list',
    'get',
    'create',
    'update',
    'rotateCredential',
    'validateRedirect',
    'reconcile',
    'revoke',
  ]);
  const metrics = mocks(['recordExternalSource']);
  const groups = [
    radio,
    engine,
    publisher,
    telemetry,
    confidence,
    webrtc,
    assets,
    scenes,
    program,
    sources,
    metrics,
  ];

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [
        RadioController,
        WebrtcController,
        MediaAssetsController,
        ScenesController,
        InstantsController,
        ExternalSourcesController,
      ],
      providers: [
        { provide: RadioService, useValue: radio },
        { provide: SongExecutionEngine, useValue: engine },
        { provide: NowPlayingPublisherService, useValue: publisher },
        { provide: PalazzoRadioTelemetryService, useValue: telemetry },
        { provide: RadioOutputConfidenceService, useValue: confidence },
        { provide: WebrtcService, useValue: webrtc },
        { provide: MediaAssetsService, useValue: assets },
        { provide: ScenesService, useValue: scenes },
        { provide: ProgramService, useValue: program },
        { provide: ExternalSourcesService, useValue: sources },
        { provide: ManagedMetricsService, useValue: metrics },
        ExternalSourceMetricsInterceptor,
      ],
    }).compile();
    const adapter = new FastifyAdapter();
    adapter.getInstance().addHook('onRequest', async (request) => {
      Object.assign(request, {
        user: {
          sub: identity.subject,
          principalId: identity.principalId,
          authorization,
        },
      });
    });
    app = module.createNestApplication<NestFastifyApplication>(adapter, {
      logger: false,
    });
    await app.init();
    await adapter.getInstance().ready();
  });

  beforeEach(() => {
    for (const group of groups)
      for (const method of Object.values(group))
        method.mockReset().mockResolvedValue(fixture);
  });
  afterAll(async () => app?.close());

  const cases: Array<
    [string, string, Record<string, jest.Mock>, string, unknown[], unknown?]
  > = [
    [
      'GET',
      '/radio/program%20a/settings',
      radio,
      'getRadioSettings',
      ['program a'],
    ],
    ['GET', '/radio/p/palazzo-status', telemetry, 'getStatus', ['p']],
    ['GET', '/radio/p/output-confidence', confidence, 'get', ['p']],
    ['GET', '/radio/p/recovery', radio, 'getRecoveryStatus', ['p']],
    [
      'POST',
      '/radio/p/recovery/prepare',
      radio,
      'prepareRecoveryPlaylist',
      ['p', [2, 8]],
      { songIds: [2, 8] },
    ],
    [
      'POST',
      '/radio/p/recovery/start',
      radio,
      'setRecoveryAutomation',
      ['p', 'start'],
      {},
    ],
    [
      'POST',
      '/radio/p/recovery/stop',
      radio,
      'setRecoveryAutomation',
      ['p', 'stop'],
      {},
    ],
    [
      'GET',
      '/radio/p/now-playing-consumers',
      publisher,
      'listConsumers',
      ['p'],
    ],
    [
      'PUT',
      '/radio/p/now-playing-consumers',
      publisher,
      'replaceConsumers',
      ['p', [{ url: 'https://consumer.invalid' }]],
      { consumers: [{ url: 'https://consumer.invalid' }] },
    ],
    ['GET', '/radio/p/status', radio, 'getPalazzoStatus', ['p']],
    ['GET', '/webrtc/config', webrtc, 'getPublicConfig', []],
    ['GET', '/webrtc/invitations', webrtc, 'listInvitations', []],
    [
      'POST',
      '/webrtc/invitations',
      webrtc,
      'createInvitation',
      [identity, { slot: 2, programId: 'p' }],
      { slot: 2, programId: 'p' },
    ],
    [
      'POST',
      '/webrtc/invitations/invite%20a/replace',
      webrtc,
      'replaceInvitation',
      [identity, 'invite a'],
      {},
    ],
    [
      'DELETE',
      '/webrtc/invitations/invite%20a',
      webrtc,
      'revokeInvitation',
      [identity, 'invite a'],
    ],
    [
      'PATCH',
      '/webrtc/invitations/i/return',
      webrtc,
      'updateReturn',
      [identity, 'i', { audio: 'aux-2' }],
      { audio: 'aux-2' },
    ],
    [
      'POST',
      '/webrtc/join',
      webrtc,
      'redeemInvitation',
      ['fixture-invitation', 'fixture-session'],
      { invitation: 'fixture-invitation', sessionToken: 'fixture-session' },
    ],
    [
      'POST',
      '/webrtc/session/heartbeat',
      webrtc,
      'heartbeat',
      ['fixture-session', { quality: 'good' }],
      { sessionToken: 'fixture-session', telemetry: { quality: 'good' } },
    ],
    [
      'POST',
      '/webrtc/commands/cmd%20a/ack',
      webrtc,
      'acknowledgeCommand',
      ['fixture-session', 'cmd a', 'accepted'],
      { sessionToken: 'fixture-session', status: 'accepted' },
    ],
    [
      'GET',
      '/webrtc/rooms/program%20a/participants',
      webrtc,
      'listParticipants',
      ['program a'],
    ],
    [
      'POST',
      '/webrtc/operator-token',
      webrtc,
      'createOperatorToken',
      [identity, 'p'],
      { programId: 'p' },
    ],
    [
      'POST',
      '/webrtc/rooms/p/participants/guest%3A2/control',
      webrtc,
      'controlParticipant',
      ['p', 'guest:2', { action: 'mute' }],
      { action: 'mute' },
    ],
    [
      'DELETE',
      '/webrtc/rooms/p/participants/guest%3A2',
      webrtc,
      'removeParticipant',
      [identity, 'p', 'guest:2'],
    ],
    [
      'GET',
      '/media-assets',
      assets,
      'findAll',
      [
        {
          search: undefined,
          mediaType: undefined,
          capability: undefined,
          labelId: undefined,
          page: 1,
          limit: 50,
        },
        authorization,
      ],
    ],
    [
      'GET',
      '/media-assets/asset%3A1',
      assets,
      'findOne',
      ['asset:1', authorization],
    ],
    [
      'POST',
      '/media-assets/background-audio',
      assets,
      'createBackgroundAudio',
      [
        {
          name: 'Bed',
          sourceUrl: 'https://media.invalid/bed.mp3',
          defaultVolume: 0.5,
        },
        authorization,
      ],
      {
        name: 'Bed',
        sourceUrl: 'https://media.invalid/bed.mp3',
        defaultVolume: 0.5,
      },
    ],
    [
      'DELETE',
      '/media-assets/asset%3A1',
      assets,
      'removeStandaloneAsset',
      ['asset:1', authorization],
    ],
    [
      'PUT',
      '/media-assets/a/labels',
      assets,
      'replaceAssetLabels',
      ['a', ['label:1'], authorization],
      { labelIds: ['label:1'] },
    ],
    [
      'GET',
      '/media-labels',
      assets,
      'findLabels',
      [{ search: undefined, page: 1, limit: 50 }, authorization],
    ],
    [
      'GET',
      '/media-labels/label%3A1/images',
      assets,
      'resolveLabelImages',
      ['label:1'],
    ],
    [
      'GET',
      '/media-labels/label%3A1',
      assets,
      'findLabel',
      ['label:1', authorization],
    ],
    [
      'POST',
      '/media-labels',
      assets,
      'createLabel',
      [{ name: 'News', description: 'Selection' }, authorization],
      { name: 'News', description: 'Selection' },
    ],
    [
      'PUT',
      '/media-labels/label%3A1',
      assets,
      'updateLabel',
      ['label:1', { name: 'Weather' }, authorization],
      { name: 'Weather' },
    ],
    [
      'PUT',
      '/media-labels/label%3A1/assets',
      assets,
      'replaceLabelAssets',
      ['label:1', ['asset:2'], authorization],
      { assetIds: ['asset:2'] },
    ],
    [
      'DELETE',
      '/media-labels/label%3A1',
      assets,
      'removeLabel',
      ['label:1', authorization],
    ],
    ['GET', '/scenes', scenes, 'findAll', []],
    ['GET', '/scenes/12', scenes, 'findOne', [12]],
    [
      'POST',
      '/scenes',
      scenes,
      'create',
      [{ name: 'Weather', layoutId: 2, metadata: { city: 'Rome' } }],
      { name: 'Weather', layoutId: 2, metadata: { city: 'Rome' } },
    ],
    [
      'PUT',
      '/scenes/12',
      scenes,
      'update',
      [12, { chyronText: 'Forecast', externalSourceId: null }],
      { chyronText: 'Forecast', externalSourceId: null },
    ],
    [
      'PUT',
      '/scenes/12/chyron',
      scenes,
      'updateChyron',
      [12, 'Forecast'],
      { chyronText: 'Forecast' },
    ],
    [
      'POST',
      '/scenes/12/modo-italiano-bracket/draw',
      scenes,
      'drawModoItalianoBracket',
      [12, { componentType: 'bracket', seed: 44 }],
      { componentType: 'bracket', seed: 44 },
    ],
    [
      'POST',
      '/scenes/12/modo-italiano-bracket/vote',
      scenes,
      'voteModoItalianoBracket',
      [12, { matchId: 1, songId: null, voterId: 'viewer' }],
      { matchId: 1, songId: null, voterId: 'viewer' },
    ],
    [
      'POST',
      '/scenes/12/modo-italiano-bracket/voting/open',
      scenes,
      'openModoItalianoBracketVoting',
      [12, { matchId: 1 }],
      { matchId: 1 },
    ],
    ['DELETE', '/scenes/12', scenes, 'remove', [12]],
    [
      'GET',
      '/instants?programId=program%20a',
      program,
      'listInstants',
      ['program a'],
    ],
    [
      'POST',
      '/instants',
      program,
      'createInstant',
      [
        {
          name: 'Sting',
          audioUrl: 'https://media.invalid/sting.wav',
          enabled: false,
        },
      ],
      {
        name: 'Sting',
        audioUrl: 'https://media.invalid/sting.wav',
        enabled: false,
      },
    ],
    [
      'PUT',
      '/instants/17',
      program,
      'updateInstant',
      [17, { volume: 0 }],
      { volume: 0 },
    ],
    ['DELETE', '/instants/17', program, 'deleteInstant', [17]],
    ['GET', '/external-sources', sources, 'list', [authorization]],
    [
      'GET',
      '/external-sources/source%3A1',
      sources,
      'get',
      ['source:1', authorization],
    ],
    [
      'POST',
      '/external-sources',
      sources,
      'create',
      [identity.subject, { name: 'Guest', transport: 'whip' }, authorization],
      { name: 'Guest', transport: 'whip' },
    ],
    [
      'PATCH',
      '/external-sources/source%3A1',
      sources,
      'update',
      ['source:1', { enabled: false }, authorization],
      { enabled: false },
    ],
    [
      'POST',
      '/external-sources/source%3A1/credentials/rotate',
      sources,
      'rotateCredential',
      ['source:1', authorization],
      {},
    ],
    [
      'POST',
      '/external-sources/source%3A1/redirects/validate',
      sources,
      'validateRedirect',
      ['source:1', 'https://media.invalid/live.m3u8', authorization],
      { url: 'https://media.invalid/live.m3u8' },
    ],
    [
      'POST',
      '/external-sources/source%3A1/reconcile',
      sources,
      'reconcile',
      ['source:1', { lifecycle: 'connected' }, authorization],
      { lifecycle: 'connected' },
    ],
    [
      'DELETE',
      '/external-sources/source%3A1',
      sources,
      'revoke',
      ['source:1', authorization],
    ],
  ];

  // Explicit undefined keeps every table row at six arguments: Jest otherwise
  // interprets the optional payload parameter as its asynchronous done callback.
  it.each(
    cases.map(
      ([method, url, group, name, args, payload]) =>
        [method, url, group, name, args, payload] as const,
    ),
  )(
    '%s %s preserves parsed request and serialized service result',
    async (method, url, group, name, args, payload) => {
      const response = await app.inject({
        method: method as 'GET',
        url,
        ...(payload === undefined
          ? {}
          : { payload: payload as Record<string, unknown> }),
      });
      expect(response.statusCode).toBe(method === 'POST' ? 201 : 200);
      expect(response.json()).toEqual(fixture);
      expect(group[name]).toHaveBeenCalledTimes(1);
      expect(group[name]).toHaveBeenCalledWith(...args);
      if (url.includes('output-confidence'))
        expect(radio.getRadioSettings).toHaveBeenCalledWith('p');
      if (url.startsWith('/external-sources'))
        expect(metrics.recordExternalSource).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      { enabled: true, palazzoUrl: 'http://same.invalid' },
      { enabled: true, palazzoUrl: 'http://same.invalid' },
      false,
    ],
    [
      { enabled: true, palazzoUrl: 'http://same.invalid' },
      { enabled: true, palazzoUrl: 'http://next.invalid' },
      true,
    ],
    [
      { enabled: true, palazzoUrl: 'http://same.invalid' },
      { enabled: false, palazzoUrl: 'http://same.invalid' },
      true,
    ],
    [undefined, { enabled: true, palazzoUrl: 'http://next.invalid' }, true],
    [undefined, { enabled: true, palazzoUrl: undefined }, true],
  ])(
    'settings changes refresh telemetry only when target or enabled changes',
    async (previous, next, changed) => {
      radio.getRadioSettings.mockResolvedValue(previous);
      radio.updateRadioSettings.mockResolvedValue(next);
      const response = await app.inject({
        method: 'PUT',
        url: '/radio/p/settings',
        payload: next,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(next);
      expect(radio.updateRadioSettings).toHaveBeenCalledWith('p', next);
      expect(telemetry.handleRadioSettingsChanged).toHaveBeenCalledTimes(
        changed ? 1 : 0,
      );
      if (changed)
        expect(telemetry.handleRadioSettingsChanged).toHaveBeenCalledWith('p');
    },
  );

  it('preserves explicit song metadata and dispatches the manual playout command once', async () => {
    const payload = {
      audioUrl: 'https://media.invalid/song.mp3',
      title: 'A song',
      artist: 'An artist',
      coverUrl: 'https://media.invalid/cover.jpg',
      durationMs: 62000,
      songId: 42,
    };
    const response = await app.inject({
      method: 'POST',
      url: '/radio/p/song',
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ ok: true });
    expect(engine.handleManualSong).toHaveBeenCalledWith(
      'p',
      payload.audioUrl,
      payload.title,
      payload.artist,
      62000,
      payload.coverUrl,
      42,
    );
  });

  it('awaits stopping the station before clearing the execution engine', async () => {
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const stopped = new Promise((resolve) => {
      release = resolve;
    });
    radio.stopSong.mockImplementation(() => {
      entered();
      return stopped;
    });
    const pending = Promise.resolve(
      app.inject({ method: 'POST', url: '/radio/p/song/stop', payload: {} }),
    );
    await requested;
    expect(radio.stopSong).toHaveBeenCalledWith('p');
    expect(engine.handleStopSong).not.toHaveBeenCalled();
    release(fixture);
    const response = await pending;
    expect(response.json()).toEqual({ ok: true });
    expect(radio.stopSong).toHaveBeenCalledWith('p');
    expect(engine.handleStopSong).toHaveBeenCalledWith('p');
    expect(radio.stopSong.mock.invocationCallOrder[0]).toBeLessThan(
      engine.handleStopSong.mock.invocationCallOrder[0],
    );
  });

  it('does not serve output confidence when program settings validation rejects the target', async () => {
    radio.getRadioSettings.mockRejectedValue(
      new BadRequestException('unknown program'),
    );
    const response = await app.inject({
      method: 'GET',
      url: '/radio/missing/output-confidence',
    });
    expect(response.statusCode).toBe(400);
    expect(confidence.get).not.toHaveBeenCalled();
  });

  it('does not acknowledge an instant when the station rejects the playout command', async () => {
    radio.playInstant.mockRejectedValue(
      new ServiceUnavailableException('station unavailable'),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/radio/p/instant',
      payload: { audioUrl: 'https://media.invalid/a.wav', instantId: 3 },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ message: 'station unavailable' });
  });

  it.each(['/radio/p/song', '/radio/p/instant'])(
    'rejects missing audioUrl before any playout: %s',
    async (url) => {
      const response = await app.inject({
        method: 'POST',
        url,
        payload: { title: 'No URL' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().message).toBe('audioUrl is required');
      expect(engine.handleManualSong).not.toHaveBeenCalled();
      expect(radio.playInstant).not.toHaveBeenCalled();
    },
  );

  it('keeps zero instant volume and supports stopping every instant', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/radio/p/instant',
          payload: {
            audioUrl: 'https://media.invalid/a.wav',
            instantId: 3,
            volume: 0,
          },
        })
      ).json(),
    ).toEqual({ ok: true });
    expect(radio.playInstant).toHaveBeenCalledWith(
      'p',
      'https://media.invalid/a.wav',
      0,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/radio/p/instant/stop',
          payload: {},
        })
      ).json(),
    ).toEqual({ ok: true });
    expect(radio.stopAllInstants).toHaveBeenCalledWith('p');
  });

  it.each([{}, { consumers: null }, { consumers: 'not-an-array' }])(
    'rejects a malformed now-playing replacement',
    async (payload) => {
      const response = await app.inject({
        method: 'PUT',
        url: '/radio/p/now-playing-consumers',
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().message).toBe('consumers must be an array');
      expect(publisher.replaceConsumers).not.toHaveBeenCalled();
    },
  );

  it('converts publisher validation failures to the HTTP400 contract', async () => {
    publisher.replaceConsumers.mockRejectedValue(
      new Error('consumer target invalid'),
    );
    const response = await app.inject({
      method: 'PUT',
      url: '/radio/p/now-playing-consumers',
      payload: { consumers: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe('Error: consumer target invalid');
  });

  it.each([
    [
      '/media-assets?search=City%20Hall&mediaType=IMAGE&capability=visual&labelId=label%3A1&page=0&limit=999',
      'findAll',
      {
        search: 'City Hall',
        mediaType: 'IMAGE',
        capability: 'visual',
        labelId: 'label:1',
        page: 1,
        limit: 200,
      },
    ],
    [
      '/media-assets?page=3&limit=0',
      'findAll',
      {
        search: undefined,
        mediaType: undefined,
        capability: undefined,
        labelId: undefined,
        page: 3,
        limit: 1,
      },
    ],
    [
      '/media-labels?search=Breaking%20News&page=0&limit=999',
      'findLabels',
      { search: 'Breaking News', page: 1, limit: 200 },
    ],
    [
      '/media-labels?page=3&limit=-5',
      'findLabels',
      { search: undefined, page: 3, limit: 1 },
    ],
  ])(
    'clamps explicit pagination and preserves decoded search: %s',
    async (url, name, query) => {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(assets[name]).toHaveBeenCalledWith(query, authorization);
    },
  );

  it.each([
    ['play', '?programId=query', { programId: 'body' }, 'query'],
    ['play', '', { programId: 'body' }, 'body'],
    ['play', '', {}, undefined],
    ['play', '', undefined, undefined],
    ['stop', '?programId=query', { programId: 'body' }, 'query'],
    ['stop', '', { programId: 'body' }, 'body'],
    ['stop', '', {}, undefined],
    ['stop', '', undefined, undefined],
  ])(
    'instant %s takes the query scope before an optional JSON body',
    async (operation, query, payload, expected) => {
      const url =
        operation === 'play'
          ? `/instants/42/play${query}`
          : `/instants/stop-all${query}`;
      const response = await app.inject({ method: 'POST', url, payload });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual(fixture);
      if (operation === 'play')
        expect(program.playInstant).toHaveBeenCalledWith(42, expected);
      else expect(program.stopAllInstants).toHaveBeenCalledWith(expected);
    },
  );

  it.each([
    ['/webrtc/renderer-token', 'createRendererToken'],
    ['/webrtc/renderer-state', 'getRendererState'],
    ['/webrtc/renderer-source-token', 'createRendererSourceToken'],
  ])(
    'keeps the renderer credential in its request header: %s',
    async (url, name) => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'x-renderer-key': 'fixture-renderer-secret' },
        payload: { programId: 'p' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual(fixture);
      expect(webrtc[name]).toHaveBeenCalledWith('fixture-renderer-secret', 'p');
    },
  );

  it('passes an absent renderer key to the validating service rather than inventing authority', async () => {
    webrtc.createRendererToken.mockRejectedValue(
      new BadRequestException('renderer key required'),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/webrtc/renderer-token',
      payload: { programId: 'p' },
    });
    expect(response.statusCode).toBe(400);
    expect(webrtc.createRendererToken).toHaveBeenCalledWith(undefined, 'p');
  });

  it.each([
    ['GET', '/scenes/not-a-number', scenes, 'findOne'],
    ['DELETE', '/instants/not-a-number', program, 'deleteInstant'],
  ])(
    'lets native service validation reject malformed numeric IDs: %s %s',
    async (method, url, group, name) => {
      group[name].mockRejectedValue(
        new BadRequestException('numeric ID required'),
      );
      const response = await app.inject({ method: method as 'GET', url });
      expect(response.statusCode).toBe(400);
      expect(response.json().message).toBe('numeric ID required');
      expect(group[name]).toHaveBeenCalledWith(NaN);
    },
  );

  it('rejects malformed JSON at the HTTP parser before touching application state', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webrtc/invitations',
      headers: { 'content-type': 'application/json' },
      payload: '{"slot":',
    });
    expect(response.statusCode).toBe(400);
    expect(webrtc.createInvitation).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', '/external-sources', 'list', 'read'],
    ['POST', '/external-sources', 'create', 'create'],
    ['PATCH', '/external-sources/source-a', 'update', 'update'],
    ['DELETE', '/external-sources/source-a', 'revoke', 'revoke'],
    [
      'POST',
      '/external-sources/source-a/credentials/rotate',
      'rotateCredential',
      'rotate',
    ],
    [
      'POST',
      '/external-sources/source-a/redirects/validate',
      'validateRedirect',
      'redirect',
    ],
    ['POST', '/external-sources/source-a/reconcile', 'reconcile', 'reconcile'],
  ])(
    'records bounded rejected operation metrics without source identifiers: %s %s',
    async (method, url, name, action) => {
      sources[name].mockRejectedValue(new ConflictException('source changed'));
      const response = await app.inject({
        method: method as 'GET',
        url,
        ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().message).toBe('source changed');
      expect(metrics.recordExternalSource).toHaveBeenCalledTimes(1);
      expect(metrics.recordExternalSource).toHaveBeenCalledWith(
        action,
        'rejected',
      );
    },
  );

  it.each([
    [new ServiceUnavailableException('fixture unavailable'), 503],
    [new Error('fixture transport failure'), 500],
    ['fixture primitive rejection', 500],
    [null, 500],
    [
      Object.assign(new Error('fixture non-error status'), { status: 399 }),
      500,
    ],
  ])(
    'records server/dependency failures separately from rejected input',
    async (error, status) => {
      sources.get.mockRejectedValue(error);
      const response = await app.inject({
        method: 'GET',
        url: '/external-sources/source-a',
      });
      expect(response.statusCode).toBe(status);
      expect(metrics.recordExternalSource).toHaveBeenCalledWith(
        'read',
        'failure',
      );
    },
  );
});
