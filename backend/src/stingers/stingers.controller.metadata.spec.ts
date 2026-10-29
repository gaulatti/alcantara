/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- Jest mocks are intentionally loosely typed. */
describe('StingersController decorator metadata', () => {
  afterEach(() => {
    jest.dontMock('./stingers.service');
  });

  it('records Object for constructor types whose tokens (StingersService) are unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('./stingers.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { StingersController } = require('./stingers.controller');
      expect(
        Reflect.getMetadata('design:paramtypes', StingersController),
      ).toEqual([Object]);
    });
  });
});
