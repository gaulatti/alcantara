describe('PalazzoMetricsPassthrough design metadata under unresolved circular imports', () => {
  it('records Object for dependencies whose modules have not resolved yet', () => {
    jest.isolateModules(() => {
      jest.doMock('@nestjs/config', () => ({}));
      jest.doMock('./managed-metrics.service', () => ({}));
      const {
        PalazzoMetricsPassthrough,
      } = require('./palazzo-metrics.passthrough');
      expect(
        Reflect.getMetadata('design:paramtypes', PalazzoMetricsPassthrough),
      ).toEqual([Object, Object, Object]);
    });
  });
});
