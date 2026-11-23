/* eslint-disable @typescript-eslint/no-require-imports */
describe('ArtistLabelsService decorator metadata', () => {
  afterEach(() => jest.resetModules());

  it('falls back to Object when collaborator classes are undefined at decoration time', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({ PrismaService: undefined }));
      jest.doMock('../observability/managed-metrics.service', () => ({
        ManagedMetricsService: undefined,
      }));
      const { ArtistLabelsService } = require('./artist-labels.service') as {
        ArtistLabelsService: new (...args: never[]) => unknown;
      };
      expect(
        Reflect.getMetadata('design:paramtypes', ArtistLabelsService),
      ).toEqual([Object, Object]);
    });
  });
});
