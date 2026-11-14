import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { BroadcastDestinationsController } from './broadcast-destinations.controller';
import { BroadcastDestinationsService } from './broadcast-destinations.service';
import { ChartsController } from '../charts/charts.controller';
import { ChartsService } from '../charts/charts.service';

// Native HTTP routing/serialization with isolated service boundaries. Global
// authorization and actual persistence remain covered by AppModule e2e tests.
describe('broadcast catalogue and public chart HTTP boundaries', () => {
  let app: NestFastifyApplication;
  const broadcast = {
    listDestinations: jest.fn(),
    createDestination: jest.fn(),
    reorderDestinations: jest.fn(),
  };
  const charts = { getSanremoRealtime: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BroadcastDestinationsController, ChartsController],
      providers: [
        { provide: BroadcastDestinationsService, useValue: broadcast },
        { provide: ChartsService, useValue: charts },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
      { logger: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => app?.close());
  beforeEach(() => jest.clearAllMocks());

  it('serializes the destination catalogue without adding privileged configuration fields', async () => {
    const catalogue = [
      { id: 'rehearsal', displayName: 'Rehearsal output', retired: false },
    ];
    broadcast.listDestinations.mockResolvedValue(catalogue);
    const response = await app.inject({
      method: 'GET',
      url: '/broadcast/destinations',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(catalogue);
    expect(broadcast.listDestinations).toHaveBeenCalledWith();
  });

  it('forwards destination registration through the parsed JSON contract', async () => {
    const body = {
      id: 'rehearsal',
      displayName: 'Rehearsal output',
      secretId: 'fixture/destination-reference',
    };
    broadcast.createDestination.mockResolvedValue({
      id: 'rehearsal',
      displayName: body.displayName,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/broadcast/destinations',
      payload: body,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      id: 'rehearsal',
      displayName: body.displayName,
    });
    expect(broadcast.createDestination).toHaveBeenCalledWith(body);
  });

  it('preserves the requested complete destination order and its explicit endpoint', async () => {
    const destinationIds = ['second', 'first'];
    broadcast.reorderDestinations.mockResolvedValue({ destinationIds });
    const response = await app.inject({
      method: 'PUT',
      url: '/broadcast/destinations/order',
      payload: { destinationIds },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ destinationIds });
    expect(broadcast.reorderDestinations).toHaveBeenCalledWith(destinationIds);
    expect(broadcast.createDestination).not.toHaveBeenCalled();
  });

  it('exposes the actual cached chart response through the public route', async () => {
    const snapshot = {
      source: 'fixture-source',
      updatedAt: '2026-01-01T00:00:00Z',
      entries: [
        { position: 1, artist: 'Fixture artist', title: 'Fixture song' },
      ],
    };
    charts.getSanremoRealtime.mockResolvedValue(snapshot);
    const response = await app.inject({
      method: 'GET',
      url: '/charts/sanremo-realtime',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(snapshot);
    expect(charts.getSanremoRealtime).toHaveBeenCalledWith();
  });
});
