import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../auth/require-permission.decorator';
import { SongReanalysisController } from './song-reanalysis.controller';

describe('SongReanalysisController (gaulatti/alcantara#235)', () => {
  const service = { request: jest.fn().mockResolvedValue('queued') };
  const controller = new SongReanalysisController(service as never);

  it('queues songs through the service, treating no body as none', async () => {
    await expect(
      controller.requestReanalysis({ songIds: [1, 2] }),
    ).resolves.toBe('queued');
    expect(service.request).toHaveBeenLastCalledWith([1, 2]);
    await controller.requestReanalysis(undefined as never);
    expect(service.request).toHaveBeenLastCalledWith(undefined);
  });

  it('needs song.manage', () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSION_KEY,
        SongReanalysisController.prototype.requestReanalysis,
      ),
    ).toBe(ALCANTARA_PERMISSIONS.song.manage);
  });
});

describe('SongReanalysisController dependency metadata', () => {
  it('records Object for the constructor type of a dependency that is not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('./song-reanalysis.service', () => ({
        SongReanalysisService: undefined,
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const loaded = require('./song-reanalysis.controller') as {
        SongReanalysisController: new (...args: never[]) => unknown;
      };
      const types = Reflect.getMetadata(
        'design:paramtypes',
        loaded.SongReanalysisController,
      ) as Array<{ name: string }>;
      expect(types.map((type) => type.name)).toEqual(['Object']);
    });
    jest.dontMock('./song-reanalysis.service');
  });
});
