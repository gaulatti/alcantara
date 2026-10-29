/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- Jest mocks are intentionally loosely typed. */
describe('LayoutsController decorator metadata', () => {
  afterEach(() => {
    jest.dontMock('./layouts.service');
  });

  it('records Object for constructor types whose tokens (LayoutsService) are unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('./layouts.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { LayoutsController } = require('./layouts.controller');
      expect(
        Reflect.getMetadata('design:paramtypes', LayoutsController),
      ).toEqual([Object]);
    });
  });
});
