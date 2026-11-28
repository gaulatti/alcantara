/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- metadata tests reflect unresolved tokens */
describe('media analysis decorator metadata', () => {
  afterEach(() => {
    jest.dontMock('../prisma.service');
    jest.dontMock('../observability/managed-metrics.service');
    jest.dontMock('./media-analysis.metrics');
    jest.dontMock('./ffmpeg-audio.analyzer');
  });

  it('records Object for constructor types whose tokens are unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({}));
      jest.doMock('../playout/playout-lease.service', () => ({
        ...jest.requireActual('../playout/playout-lease.service'),
        PlayoutLease: undefined,
      }));
      jest.doMock('../observability/managed-metrics.service', () => ({}));
      jest.doMock('./media-analysis.metrics', () => ({}));
      jest.doMock('./ffmpeg-audio.analyzer', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { MediaAnalysisService } = require('./media-analysis.service');
      const { MediaAnalysisMetrics } = jest.requireActual(
        './media-analysis.metrics',
      );
      expect(
        Reflect.getMetadata('design:paramtypes', MediaAnalysisService),
      ).toEqual([Object, Object, Object, Object]);
      expect(
        Reflect.getMetadata('design:paramtypes', MediaAnalysisMetrics),
      ).toEqual([Object]);
    });
  });
});
