/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- modules are loaded inside jest.isolateModules with their dependencies mocked away. */
describe('instant and stinger provider decorator metadata under unresolved circular imports', () => {
  it('records Object for dependencies whose modules are not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('../../program/program.service', () => ({}));
      jest.doMock('../../radio/radio.service', () => ({}));
      jest.doMock('../../auth/pompeii.service', () => ({}));
      jest.doMock('../../stingers/stingers.service', () => ({}));
      const { InstantsMcpTools } = require('./instants');
      const { StingersMcpTools } = require('./stingers');
      expect(
        Reflect.getMetadata('design:paramtypes', InstantsMcpTools),
      ).toEqual([Object, Object, Object]);
      expect(
        Reflect.getMetadata('design:paramtypes', StingersMcpTools),
      ).toEqual([Object, Object, Object]);
    });
  });
});
