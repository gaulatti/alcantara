/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- metadata tests reflect unresolved tokens */
describe('AsRunService decorator metadata', () => {
  afterEach(() => {
    jest.dontMock('../prisma.service');
    jest.dontMock('../radio/song-execution.engine');
    jest.dontMock('../radio/radio-metrics.service');
  });

  it('records Object for constructor types whose tokens are unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({}));
      jest.doMock('../radio/song-execution.engine', () => ({}));
      jest.doMock('../radio/radio-metrics.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AsRunService } = require('./as-run.service');
      expect(Reflect.getMetadata('design:paramtypes', AsRunService)).toEqual([
        Object,
        Object,
        Object,
      ]);
    });
  });
});
