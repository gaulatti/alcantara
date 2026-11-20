/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-require-imports -- Jest mocks are intentionally loosely typed. */
describe('access classes: design metadata under unresolved circular imports', () => {
  afterEach(() => {
    jest.dontMock('../auth/pompeii.service');
    jest.dontMock('../observability/managed-metrics.service');
    jest.dontMock('./access.service');
  });

  it('records Object for AccessService dependencies whose modules are not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('../auth/pompeii.service', () => ({}));
      jest.doMock('../observability/managed-metrics.service', () => ({}));
      const { AccessService } = require('./access.service');
      expect(Reflect.getMetadata('design:paramtypes', AccessService)).toEqual([
        Object,
        Object,
      ]);
    });
  });

  it('records Object for the controller and the MCP provider when AccessService is not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('./access.service', () => ({}));
      const { AccessController } = require('./access.controller');
      const { AccessMcpTools } = require('../mcp/capabilities/access');
      expect(
        Reflect.getMetadata('design:paramtypes', AccessController),
      ).toEqual([Object]);
      expect(Reflect.getMetadata('design:paramtypes', AccessMcpTools)).toEqual([
        Object,
      ]);
    });
  });
});
