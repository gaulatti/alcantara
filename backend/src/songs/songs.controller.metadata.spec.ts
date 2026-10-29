/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- Jest mocks are intentionally loosely typed. */
describe('SongsController decorator metadata', () => {
  afterEach(() => {
    jest.dontMock('./songs.service');
  });

  it('records Object for constructor types whose tokens (SongsService) are unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('./songs.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { SongsController } = require('./songs.controller');
      expect(Reflect.getMetadata('design:paramtypes', SongsController)).toEqual(
        [Object],
      );
    });
  });
});
