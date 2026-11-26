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
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  HttpMetricsHook,
  SONG_PLAYBACK_WRITE_ROUTE,
} from './http-metrics.hook';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

let refuseWrites = false;
class WriteGuard implements CanActivate {
  canActivate(): boolean {
    return !refuseWrites;
  }
}

@Controller('program')
class SongPlaybackController {
  @Get(':programId/song-playback')
  read() {
    return {};
  }

  @Post(':programId/song-playback')
  @UseGuards(WriteGuard)
  write() {
    return {};
  }
}

@Module({
  controllers: [SongsController, LockedController, SongPlaybackController],
  providers: [ManagedMetricsService, HttpMetricsHook],
})
class MetricsFixtureModule {}

/** One exposition line's labels and value, for the series named `name`. */
function series(
  exposition: string,
  name: string,
): { labels: Record<string, string>; value: number }[] {
  return exposition
    .split('\n')
    .filter((line) => line.startsWith(`${name}{`))
    .map((line) => {
      const labels = Object.fromEntries(
        [
          ...line
            .slice(line.indexOf('{') + 1, line.indexOf('}'))
            .matchAll(/(\w+)="([^"]*)"/g),
        ].map((m) => [m[1], m[2]]),
      );
      return { labels, value: Number(line.split(' ').pop()) };
    });
}

describe('HTTP metrics through the Fastify adapter', () => {
  let app: NestFastifyApplication;
  let metrics: ManagedMetricsService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [MetricsFixtureModule],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
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
          entry.labels.method === method &&
          entry.labels.route === route &&
          entry.labels.status_class === statusClass,
      )?.value;

    expect(count('GET', 'songs', '2xx')).toBe(1);
    expect(count('POST', 'songs', '2xx')).toBe(1);
    expect(count('GET', 'songs', '4xx')).toBe(1);
    expect(count('GET', 'unmatched', '4xx')).toBe(1);
    for (const entry of requests) {
      expect(Object.keys(entry.labels).sort()).toEqual([
        'method',
        'route',
        'status_class',
      ]);
      expect(entry.labels.route).not.toContain('/');
      expect(entry.labels.route).not.toContain('42');
      expect(entry.labels.route).not.toContain('a1b2c3');
      expect(entry.labels.route).not.toContain('locked');
    }
  });

  it('counts calls to the song-playback write route, a guard refusal included, and not its read (#612)', async () => {
    const writes = async () =>
      Object.fromEntries(
        series(
          await metrics.registry.metrics(),
          'alcantara_program_song_playback_writes_total',
        ).map((entry) => [entry.labels.result, entry.value]),
      );
    await expect(writes()).resolves.toEqual({ accepted: 0, refused: 0 });
    const url = '/program/secret-program/song-playback';
    await app.inject({ method: 'GET', url });
    await app.inject({ method: 'POST', url: '/songs' });
    await expect(writes()).resolves.toEqual({ accepted: 0, refused: 0 });

    await app.inject({ method: 'POST', url, payload: { token: 'secret' } });
    refuseWrites = true;
    await app.inject({ method: 'POST', url, payload: { token: 'secret' } });
    await expect(writes()).resolves.toEqual({ accepted: 1, refused: 1 });
    expect(await metrics.registry.metrics()).not.toContain('secret');
  });

  it('counts a route the application still has', () => {
    const inventory = readFileSync(
      join(__dirname, '../api-surface/route-inventory.json'),
      'utf8',
    );
    expect(inventory).toContain(`"${SONG_PLAYBACK_WRITE_ROUTE}"`);
  });

  it('keeps the song-playback result label bounded', async () => {
    metrics.recordSongPlaybackWrite('anything');
    const labels = series(
      await metrics.registry.metrics(),
      'alcantara_program_song_playback_writes_total',
    ).map((entry) => entry.labels.result);
    expect(labels).toContain('unknown');
    expect(labels).not.toContain('anything');
  });
});
