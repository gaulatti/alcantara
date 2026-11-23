/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- modules are loaded inside jest.isolateModules with their dependencies mocked away. */
describe('as-run capability provider decorator metadata under unresolved circular imports', () => {
  it('records Object for a dependency whose module is not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('../../as-run/as-run.service', () => ({}));
      const { AsRunMcpTools } = require('./as-run');
      expect(Reflect.getMetadata('design:paramtypes', AsRunMcpTools)).toEqual([
        Object,
      ]);
    });
  });
});
