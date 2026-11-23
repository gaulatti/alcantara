import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../auth/require-permission.decorator';
import { ArtistLabelsController } from './artist-labels.controller';
import type { ArtistLabelsService } from './artist-labels.service';

describe('ArtistLabelsController', () => {
  const service = { list: jest.fn(), set: jest.fn() };
  const controller = new ArtistLabelsController(
    service as unknown as ArtistLabelsService,
  );
  const request = { user: { authorization: { teamId: 7 } } };

  beforeEach(() => jest.resetAllMocks());

  it('lists and sets the links for the caller team', async () => {
    service.list.mockResolvedValue([{ artistKey: 'rob' }]);
    service.set.mockResolvedValue({ artistKey: 'rob' });
    await expect(controller.list(request)).resolves.toEqual([
      { artistKey: 'rob' },
    ]);
    expect(service.list).toHaveBeenCalledWith(7);
    await controller.set({ artist: 'Rob', labelId: 'label-a' }, request);
    expect(service.set).toHaveBeenCalledWith(7, 'Rob', 'label-a');
    await controller.set({ artist: 'Rob', labelId: null }, request);
    expect(service.set).toHaveBeenLastCalledWith(7, 'Rob', null);
    await controller.set(undefined as never, request);
    expect(service.set).toHaveBeenLastCalledWith(7, undefined, undefined);
  });

  it('needs media.read to read and media.manage to write', () => {
    const permission = (handler: keyof ArtistLabelsController) =>
      Reflect.getMetadata(
        REQUIRED_PERMISSION_KEY,
        ArtistLabelsController.prototype[handler],
      ) as string;
    expect(permission('list')).toBe(ALCANTARA_PERMISSIONS.media.read);
    expect(permission('set')).toBe(ALCANTARA_PERMISSIONS.media.manage);
  });
});
