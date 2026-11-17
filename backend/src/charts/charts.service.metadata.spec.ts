/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- Jest mocks are intentionally loosely typed. */
describe('ChartsService decorator metadata', () => {
  afterEach(() => {
    jest.dontMock('../observability/managed-metrics.service');
    jest.dontMock('../prisma.service');
  });

  it('records Object for constructor types whose tokens (PrismaService, ManagedMetricsService) are unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('../observability/managed-metrics.service', () => ({}));
      jest.doMock('../prisma.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ChartsService } = require('./charts.service');
      expect(Reflect.getMetadata('design:paramtypes', ChartsService)).toEqual([
        Object,
        Object,
      ]);
    });
  });
});
