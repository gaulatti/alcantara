/* eslint-disable @typescript-eslint/no-require-imports */
describe('BroadcastDestinationKeysService decorator metadata', () => {
  afterEach(() => jest.resetModules());

  it('falls back to Object when collaborator classes are undefined at decoration time', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({ PrismaService: undefined }));
      jest.doMock('../observability/managed-metrics.service', () => ({
        ManagedMetricsService: undefined,
      }));
      jest.doMock('./destination-secrets.service', () => ({
        DestinationSecretsService: undefined,
      }));
      const { BroadcastDestinationKeysService } =
        require('./broadcast-destination-keys.service') as {
          BroadcastDestinationKeysService: new (...args: never[]) => unknown;
        };
      expect(
        Reflect.getMetadata(
          'design:paramtypes',
          BroadcastDestinationKeysService,
        ),
      ).toEqual([Object, Object, Object]);
    });
  });
});
