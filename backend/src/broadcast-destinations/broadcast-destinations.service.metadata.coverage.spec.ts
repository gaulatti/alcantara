/* eslint-disable @typescript-eslint/no-require-imports */
describe('BroadcastDestinationsService decorator metadata', () => {
  afterEach(() => jest.resetModules());

  it('falls back to Object when collaborator classes are undefined at decoration time', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({ PrismaService: undefined }));
      jest.doMock('../observability/managed-metrics.service', () => ({
        ManagedMetricsService: undefined,
      }));
      jest.doMock('./alana.client', () => ({
        AlanaClient: undefined,
        AlanaRequestError: class AlanaRequestError extends Error {},
      }));
      const { BroadcastDestinationsService } =
        require('./broadcast-destinations.service') as {
          BroadcastDestinationsService: new (...args: never[]) => unknown;
        };
      expect(
        Reflect.getMetadata('design:paramtypes', BroadcastDestinationsService),
      ).toEqual([Object, Object, Object]);
    });
  });
});
