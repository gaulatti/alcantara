/* eslint-disable @typescript-eslint/no-require-imports */
describe('BroadcastIngestService decorator metadata', () => {
  afterEach(() => jest.resetModules());

  it('falls back to Object when collaborator classes are undefined at decoration time', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({ PrismaService: undefined }));
      jest.doMock('../observability/managed-metrics.service', () => ({
        ManagedMetricsService: undefined,
      }));
      const { BroadcastIngestService } =
        require('./broadcast-ingest.service') as {
          BroadcastIngestService: new (...args: never[]) => unknown;
        };
      expect(
        Reflect.getMetadata('design:paramtypes', BroadcastIngestService),
      ).toEqual([Object, Object]);
    });
  });
});
