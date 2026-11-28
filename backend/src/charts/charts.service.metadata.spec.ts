/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- Jest mocks are intentionally loosely typed. */
describe('ChartsService decorator metadata', () => {
  afterEach(() => {
    jest.dontMock('../observability/managed-metrics.service');
    jest.dontMock('../prisma.service');
    jest.dontMock('@nestjs/config');
  });

  it('records Object for constructor types whose tokens (PrismaService, ManagedMetricsService, ConfigService) are unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('../observability/managed-metrics.service', () => ({}));
      jest.doMock('../playout/playout-lease.service', () => ({
        ...jest.requireActual('../playout/playout-lease.service'),
        PlayoutLease: undefined,
      }));
      jest.doMock('../prisma.service', () => ({}));
      jest.doMock('@nestjs/config', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ChartsService } = require('./charts.service');
      expect(Reflect.getMetadata('design:paramtypes', ChartsService)).toEqual([
        Object,
        Object,
        Object,
        Object,
      ]);
    });
  });
});
