/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- Jest mocks are intentionally loosely typed. */

describe('ScenesService decorator metadata', () => {
  afterEach(() => {
    jest.dontMock('../prisma.service');
    jest.dontMock('../program/program.service');
  });

  it('records Object for constructor types whose tokens (PrismaService, ProgramService) are unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({}));
      jest.doMock('../program/program.service', () => ({}));
      jest.doMock('../operator-change/operator-change-recorder', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ScenesService } = require('./scenes.service');
      expect(
        (
          Reflect.getMetadata('design:paramtypes', ScenesService) as Array<{
            name: string;
          }>
        ).map((type) => type.name),
      ).toEqual(['Object', 'Object', 'Object']);
    });
  });
});
