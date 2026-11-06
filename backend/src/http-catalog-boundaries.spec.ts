import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { SongsController } from './songs/songs.controller';
import { SongsService } from './songs/songs.service';
import { MediaController } from './media/media.controller';
import { MediaService } from './media/media.service';
import { MediaGroupsController } from './media-groups/media-groups.controller';
import { MediaGroupsService } from './media-groups/media-groups.service';
import { LayoutsController } from './layouts/layouts.controller';
import { LayoutsService } from './layouts/layouts.service';
import { StingersController } from './stingers/stingers.controller';
import { StingersService } from './stingers/stingers.service';
import { OperatorPreferencesController } from './operator-preferences/operator-preferences.controller';
import { OperatorPreferencesService } from './operator-preferences/operator-preferences.service';
import { AuthController } from './auth/auth.controller';
import { RealtimeTicketService } from './auth/realtime-ticket.service';

// Native routing/serialization with a resolved fixture identity. These do not
// substitute for AppModule's independent real global-authorization e2e tests.
describe('catalogue, preference and ticket contracts through Fastify HTTP', () => {
  let app: NestFastifyApplication;
  const identity = {
    sub: 'fixture-subject',
    principalId: 'fixture-principal',
    authorization: { permissions: ['fixture'], roles: ['operator'], teamId: 7 },
  };
  const answer = { id: 41, name: 'Fixture response', enabled: false };
  const methods = (names: string[]) =>
    Object.fromEntries(names.map((name) => [name, jest.fn()]));
  const catalogues = [
    {
      path: 'songs',
      controller: SongsController,
      token: SongsService,
      service: methods(['findAll', 'findOne', 'create', 'update', 'remove']),
      body: {
        artist: 'Fixture artist',
        title: 'Fixture song',
        enabled: false,
        introInstantId: null,
        durationMs: 0,
      },
      hasOne: true,
    },
    {
      path: 'media',
      controller: MediaController,
      token: MediaService,
      service: methods(['findAll', 'findOne', 'create', 'update', 'remove']),
      body: {
        name: 'Fixture image',
        imageUrl: 'https://media.invalid/image.png',
      },
      hasOne: true,
    },
    {
      path: 'media-groups',
      controller: MediaGroupsController,
      token: MediaGroupsService,
      service: methods(['findAll', 'findOne', 'create', 'update', 'remove']),
      body: { name: 'Fixture label', description: null, mediaIds: [7, 2] },
      hasOne: true,
    },
    {
      path: 'layouts',
      controller: LayoutsController,
      token: LayoutsService,
      service: methods(['findAll', 'findOne', 'create', 'update', 'remove']),
      body: {
        name: 'Fixture layout',
        componentType: 'Scoreboard',
        settings: { enabled: false },
      },
      hasOne: true,
    },
    {
      path: 'stingers',
      controller: StingersController,
      token: StingersService,
      service: methods(['findAll', 'create', 'update', 'remove']),
      body: {
        name: 'Fixture transition',
        videoUrl: 'https://media.invalid/cut.webm',
        cutPointMs: 0,
        enabled: false,
      },
      hasOne: false,
    },
  ];
  const preferences = methods([
    'discover',
    'publish',
    'load',
    'retire',
    'get',
    'save',
    'reset',
  ]);
  const tickets = methods(['issue']);

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [
        ...catalogues.map((item) => item.controller),
        OperatorPreferencesController,
        AuthController,
      ],
      providers: [
        ...catalogues.map((item) => ({
          provide: item.token,
          useValue: item.service,
        })),
        { provide: OperatorPreferencesService, useValue: preferences },
        { provide: RealtimeTicketService, useValue: tickets },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
      { logger: false },
    );
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onRequest', async (request: object) => {
        Object.assign(request, { user: identity });
      });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    for (const service of [
      ...catalogues.map((item) => item.service),
      preferences,
      tickets,
    ]) {
      for (const method of Object.values(service))
        method.mockReset().mockResolvedValue(answer);
    }
  });

  for (const item of catalogues) {
    describe(item.path, () => {
      it('serializes collection reads over the actual route', async () => {
        item.service.findAll.mockResolvedValue([answer]);
        const response = await app.inject({
          method: 'GET',
          url: `/${item.path}`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual([answer]);
        expect(item.service.findAll).toHaveBeenCalledTimes(1);
      });
      if (item.hasOne) {
        it('decodes numeric path identifiers and carries downstream not-found responses', async () => {
          const response = await app.inject({
            method: 'GET',
            url: `/${item.path}/41`,
          });
          expect(response.statusCode).toBe(200);
          expect(response.json()).toEqual(answer);
          expect(item.service.findOne.mock.calls[0][0]).toBe(41);
          item.service.findOne.mockRejectedValueOnce(
            new NotFoundException('Unknown fixture item'),
          );
          const missing = await app.inject({
            method: 'GET',
            url: `/${item.path}/999`,
          });
          expect(missing.statusCode).toBe(404);
          expect(missing.json().message).toBe('Unknown fixture item');
        });
      }
      it('preserves valid false, zero, null and ordered fields when creating and editing', async () => {
        const created = await app.inject({
          method: 'POST',
          url: `/${item.path}`,
          payload: item.body,
        });
        expect(created.statusCode).toBe(201);
        expect(created.json()).toEqual(answer);
        expect(item.service.create).toHaveBeenCalledWith(item.body);
        const edited = await app.inject({
          method: 'PUT',
          url: `/${item.path}/41`,
          payload: item.body,
        });
        expect(edited.statusCode).toBe(200);
        expect(edited.json()).toEqual(answer);
        expect(item.service.update).toHaveBeenCalledWith(41, item.body);
      });
      it('deletes exactly the requested identifier', async () => {
        const response = await app.inject({
          method: 'DELETE',
          url: `/${item.path}/41`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(answer);
        expect(item.service.remove).toHaveBeenCalledWith(41);
      });
      it('rejects malformed JSON before a catalogue mutation can run', async () => {
        const response = await app.inject({
          method: 'POST',
          url: `/${item.path}`,
          headers: { 'content-type': 'application/json' },
          payload: '{',
        });
        expect(response.statusCode).toBe(400);
        expect(item.service.create).not.toHaveBeenCalled();
      });
    });
  }

  it.each([
    [
      'songs',
      '',
      {
        search: undefined,
        enabled: undefined,
        sortBy: undefined,
        sortOrder: undefined,
        page: 1,
        limit: 50,
        programId: undefined,
      },
    ],
    [
      'songs',
      '?search=title+artist&enabled=true&sortBy=title&sortOrder=asc&page=2&limit=0&programId=radio%2Fone',
      {
        search: 'title artist',
        enabled: true,
        sortBy: 'title',
        sortOrder: 'asc',
        page: 2,
        limit: 0,
        programId: 'radio/one',
      },
    ],
    [
      'songs',
      '?enabled=false&page=0&limit=-1',
      {
        search: undefined,
        enabled: false,
        sortBy: undefined,
        sortOrder: undefined,
        page: 1,
        limit: 0,
        programId: undefined,
      },
    ],
    [
      'media',
      '',
      {
        search: undefined,
        sortBy: undefined,
        sortOrder: undefined,
        page: 1,
        limit: 50,
      },
    ],
    [
      'media',
      '?search=still&sortBy=name&sortOrder=desc&page=2&limit=999',
      {
        search: 'still',
        sortBy: 'name',
        sortOrder: 'desc',
        page: 2,
        limit: 200,
      },
    ],
    [
      'media',
      '?page=-1&limit=0',
      {
        search: undefined,
        sortBy: undefined,
        sortOrder: undefined,
        page: 1,
        limit: 1,
      },
    ],
    [
      'media-groups',
      '',
      {
        search: undefined,
        sortBy: undefined,
        sortOrder: undefined,
        page: 1,
        limit: 20,
      },
    ],
    [
      'media-groups',
      '?search=label&sortBy=name&sortOrder=asc&page=3&limit=0',
      { search: 'label', sortBy: 'name', sortOrder: 'asc', page: 3, limit: 0 },
    ],
  ])(
    'preserves documented %s pagination/search semantics (%s)',
    async (name, query, expected) => {
      const item = catalogues.find((entry) => entry.path === name)!;
      const response = await app.inject({
        method: 'GET',
        url: `/${name}${query}`,
      });
      expect(response.statusCode).toBe(200);
      expect(item.service.findAll).toHaveBeenCalledWith(expected);
    },
  );

  it('forwards program-scoped song reads and opaque shared-layout scope IDs without rewriting them', async () => {
    await app.inject({ method: 'GET', url: '/songs/41?programId=radio%2Fone' });
    expect(catalogues[0].service.findOne).toHaveBeenCalledWith(41, 'radio/one');
    const found = await app.inject({
      method: 'GET',
      url: '/operator-preferences/shared?scope=program&scopeId=radio%2Fone',
    });
    expect(found.statusCode).toBe(200);
    expect(preferences.discover).toHaveBeenCalledWith(
      'program',
      'radio/one',
      identity.authorization,
    );
  });

  it('binds preference publication/load/retirement to the resolved request identity and authorization', async () => {
    const owner = { subject: identity.sub, principalId: identity.principalId };
    const body = {
      scope: 'program',
      scopeId: 'radio/one',
      profile: { enabled: false },
      version: 7,
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator-preferences/shared',
          payload: body,
        })
      ).statusCode,
    ).toBe(201);
    expect(preferences.publish).toHaveBeenCalledWith(
      owner,
      body,
      identity.authorization,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator-preferences/shared/layout%2Fone/load',
          payload: { version: 7, deviceClass: 'desktop' },
        })
      ).statusCode,
    ).toBe(201);
    expect(preferences.load).toHaveBeenCalledWith(
      owner,
      'layout/one',
      { version: 7, deviceClass: 'desktop' },
      identity.authorization,
    );
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/operator-preferences/shared/layout%2Fone',
        })
      ).statusCode,
    ).toBe(200);
    expect(preferences.retire).toHaveBeenCalledWith(
      'layout/one',
      identity.authorization,
    );
  });

  it('keeps device-specific get/save/reset distinct from resetting every device', async () => {
    const owner = { subject: identity.sub, principalId: identity.principalId };
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/operator-preferences/desktop',
        })
      ).statusCode,
    ).toBe(200);
    expect(preferences.get).toHaveBeenCalledWith(owner, 'desktop');
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/operator-preferences/desktop',
          payload: { version: 3, profile: { enabled: false } },
        })
      ).statusCode,
    ).toBe(200);
    expect(preferences.save).toHaveBeenCalledWith(owner, 'desktop', {
      version: 3,
      profile: { enabled: false },
    });
    await app.inject({
      method: 'DELETE',
      url: '/operator-preferences/desktop',
    });
    expect(preferences.reset).toHaveBeenLastCalledWith(owner, 'desktop');
    await app.inject({ method: 'DELETE', url: '/operator-preferences' });
    expect(preferences.reset).toHaveBeenLastCalledWith(owner);
  });

  it('returns only the resolved user from the auth profile route', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(identity);
  });

  it.each([
    [{ programId: 'radio/one' }, 'radio/one'],
    [{}, 'main'],
    [{ programId: null }, 'main'],
    [{ programId: 7 }, 'main'],
  ])(
    'selects an explicitly textual program for realtime tickets (%#)',
    async (body, expected) => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/realtime-ticket',
        payload: body,
      });
      expect(response.statusCode).toBe(201);
      expect(tickets.issue).toHaveBeenCalledWith(expected);
    },
  );
});
