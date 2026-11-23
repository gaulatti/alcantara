describe('MetricsController design metadata under unresolved circular imports', () => {
  it('records Object for dependencies whose modules have not resolved yet', () => {
    jest.isolateModules(() => {
      jest.doMock('./radio/radio-metrics.service', () => ({}));
      jest.doMock('./observability/managed-metrics.service', () => ({}));
      jest.doMock('./observability/palazzo-metrics.passthrough', () => ({}));
      const { MetricsController } = require('./metrics.controller');
      expect(
        Reflect.getMetadata('design:paramtypes', MetricsController),
      ).toEqual([Object, Object, Object]);
    });
  });

  it('records Object as the return type when Promise is unavailable at decoration time', () => {
    const original = globalThis.Promise;
    jest.isolateModules(() => {
      jest.doMock('./radio/radio-metrics.service', () => ({
        RadioMetricsService: class RadioMetricsService {},
      }));
      jest.doMock('./observability/managed-metrics.service', () => ({
        ManagedMetricsService: class ManagedMetricsService {},
      }));
      jest.doMock('./observability/palazzo-metrics.passthrough', () => ({
        PalazzoMetricsPassthrough: class PalazzoMetricsPassthrough {},
      }));
      // Warm the module registry so only metrics.controller is evaluated
      // while Promise is unavailable.
      require('@nestjs/common');
      require('./auth/public.decorator');
      require('./observability/metrics-token.guard');
      let MetricsController: { prototype: object };
      try {
        (globalThis as { Promise?: unknown }).Promise = undefined;
        ({ MetricsController } = require('./metrics.controller'));
      } finally {
        globalThis.Promise = original;
      }
      expect(
        Reflect.getMetadata(
          'design:returntype',
          MetricsController.prototype,
          'getMetrics',
        ),
      ).toBe(Object);
    });
  });
});
