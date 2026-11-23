import {
  CanActivate,
  Controller,
  Get,
  Module,
  Post,
  UseGuards,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { HttpMetricsHook } from './http-metrics.hook';
import { ManagedMetricsService } from './managed-metrics.service';

class RefuseGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

@Controller('songs')
class SongsController {
  @Get(':id')
  find() {
    return { id: 1 };
  }

  @Post()
  create() {
    return { created: true };
  }
}

@Controller('songs')
class LockedController {
  @Get('locked')
  @UseGuards(RefuseGuard)
  read() {
    return { never: true };
  }
}

@Module({
  controllers: [SongsController, LockedController],
  providers: [ManagedMetricsService, HttpMetricsHook],
})
class MetricsFixtureModule {}

/** One exposition line's labels and value, for the series named `name`. */
function series(exposition: string, name: string): { labels: Record<string, string>; value: number }[] {
  return exposition
    .split('\n')
    .filter((line) => line.startsWith(`${name}{`))
    .map((line) => {
      const labels = Object.fromEntries(
        [...line.slice(line.indexOf('{') + 1, line.indexOf('}')).matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
      );
      return { labels, value: Number(line.split(' ').pop()) };
    });
}

describe('HTTP metrics through the Fastify adapter', () => {
  let app: INestApplication;
  let metrics: ManagedMetricsService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [MetricsFixtureModule] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    metrics = module.get(ManagedMetricsService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('counts GET and POST on a matched route group, a guard refusal and an unmatched path, with bounded labels', async () => {
    await app.inject({ method: 'GET', url: '/songs/42?x=1' });
    await app.inject({ method: 'POST', url: '/songs' });
    await app.inject({ method: 'GET', url: '/songs/locked' });
    await app.inject({ method: 'GET', url: '/no/such/path/a1b2c3' });

    const exposition = await metrics.registry.metrics();
    const requests = series(exposition, 'alcantara_http_requests_total');
    const count = (method: string, route: string, statusClass: string) =>
      requests.find(
        (entry) =>
          entry.labels.method === method && entry.labels.route === route && entry.labels.status_class === statusClass,
      )?.value;

    expect(count('GET', 'songs', '2xx')).toBe(1);
    expect(count('POST', 'songs', '2xx')).toBe(1);
    expect(count('GET', 'songs', '4xx')).toBe(1);
    expect(count('GET', 'unmatched', '4xx')).toBe(1);
    for (const entry of requests) {
      expect(Object.keys(entry.labels).sort()).toEqual(['method', 'route', 'status_class']);
      expect(entry.labels.route).not.toContain('/');
      expect(entry.labels.route).not.toContain('42');
      expect(entry.labels.route).not.toContain('a1b2c3');
      expect(entry.labels.route).not.toContain('locked');
    }
  });
});
