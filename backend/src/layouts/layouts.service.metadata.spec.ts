/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- Jest mocks are intentionally loosely typed. */
describe('LayoutsService decorator metadata', () => {
  afterEach(() => jest.dontMock('../prisma.service'));

  it('records Object as the constructor type when the PrismaService token is unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { LayoutsService } = require('./layouts.service');
      expect(Reflect.getMetadata('design:paramtypes', LayoutsService)).toEqual([
        Object,
      ]);
    });
  });
});
