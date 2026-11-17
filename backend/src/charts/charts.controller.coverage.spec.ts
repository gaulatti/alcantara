import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { ChartsController } from './charts.controller';

describe('ChartsController', () => {
  it('returns the realtime chart snapshot from the service', async () => {
    const snapshot = { updatedAt: 'x', sources: {}, entries: [] };
    const service = {
      getSanremoRealtime: jest.fn().mockResolvedValue(snapshot),
    };
    const controller = new ChartsController(service as never);
    await expect(controller.getSanremoRealtime()).resolves.toBe(snapshot);
    expect(service.getSanremoRealtime).toHaveBeenCalledTimes(1);
  });

  it('returns the provider-neutral feed from the service', async () => {
    const feed = [{ provider: 'provider-a', externalId: '1' }];
    const service = { getRealtimeFeed: jest.fn().mockResolvedValue(feed) };
    const controller = new ChartsController(service as never);
    await expect(controller.getRealtimeFeed()).resolves.toBe(feed);
  });

  it('is marked public', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, ChartsController)).toBe(true);
  });
});
