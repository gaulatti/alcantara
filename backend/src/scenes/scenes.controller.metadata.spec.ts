/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- Jest mocks are intentionally loosely typed. */
describe('ScenesController decorator metadata', () => {
  afterEach(() => {
    jest.dontMock('./scenes.service');
  });

  it('records Object for constructor types whose tokens (ScenesService) are unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('./scenes.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ScenesController } = require('./scenes.controller');
      expect(
        Reflect.getMetadata('design:paramtypes', ScenesController),
      ).toEqual([Object]);
    });
  });
});
