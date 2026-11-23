import { ConfigService } from '@nestjs/config';
import { ChartsService } from './charts.service';
import type { PrismaService } from '../prisma.service';

// gaulatti/alcantara#206: outside production the third-party chart feeds are
// never polled; production polls as before. No feed address appears in a log.

function build(nodeEnv: string) {
  return new ChartsService(
    {
      song: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService,
    undefined,
    new ConfigService({ NODE_ENV: nodeEnv }),
  );
}

describe('ChartsService outside production', () => {
  afterEach(() => jest.restoreAllMocks());

  it('contacts no chart feed, schedules no poll and says so once', async () => {
    const service = build('development');
    const fetchSpy = jest.spyOn(global, 'fetch');
    const timer = jest.spyOn(global, 'setInterval');
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation();

    service.onModuleInit();
    await expect(service.getRealtimeFeed()).resolves.toEqual([]);

    expect(service.pollingEnabled()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      'Chart polling is off outside production; no external chart feed is contacted',
    );
    service.onModuleDestroy();
  });

  it('polls in production', () => {
    const service = build('production');
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    jest.spyOn(service['logger'], 'warn').mockImplementation();
    jest.spyOn(service['logger'], 'error').mockImplementation();
    const timer = jest
      .spyOn(global, 'setInterval')
      .mockReturnValue(0 as unknown as NodeJS.Timeout);
    jest.spyOn(global, 'clearInterval').mockImplementation();

    service.onModuleInit();

    expect(service.pollingEnabled()).toBe(true);
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 15000);
    expect(global.fetch).toHaveBeenCalled();
    service.onModuleDestroy();
  });
});
