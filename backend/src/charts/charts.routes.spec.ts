import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ChartsController } from './charts.controller';
import { ChartsService } from './charts.service';

// gaulatti/alcantara#165: the branded chart proxy is retired; the
// provider-neutral feed is the charts module's only route.
describe('charts routes', () => {
  let app: NestFastifyApplication;
  const feed = [{ provider: 'provider-a', externalId: '1' }];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ChartsController],
      providers: [
        {
          provide: ChartsService,
          useValue: { getRealtimeFeed: jest.fn().mockResolvedValue(feed) },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 404 for the retired branded proxy', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/charts/sanremo-realtime',
    });
    expect(response.statusCode).toBe(404);
  });

  it('still serves the provider-neutral feed', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/charts/realtime',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(feed);
  });
});
