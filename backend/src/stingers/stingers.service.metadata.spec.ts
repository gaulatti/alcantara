/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- Jest mocks are intentionally loosely typed. */
describe('StingersService decorator metadata', () => {
  afterEach(() => {
    jest.dontMock('../prisma.service');
    jest.dontMock('../operator-change/operator-change-recorder');
  });

  it('records Object for constructor types whose tokens (PrismaService, OperatorChangeRecorder) are unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({}));
      jest.doMock('../operator-change/operator-change-recorder', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { StingersService } = require('./stingers.service');
      expect(Reflect.getMetadata('design:paramtypes', StingersService)).toEqual(
        [Object, Object],
      );
    });
  });
});
