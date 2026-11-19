/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- modules are loaded inside jest.isolateModules with their dependencies mocked away. */
describe('MCP design metadata under unresolved circular imports', () => {
  it('records Object for dependencies whose modules are not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('../auth/pompeii.service', () => ({}));
      jest.doMock('../auth/test-auth.service', () => ({}));
      jest.doMock('../observability/managed-metrics.service', () => ({}));
      jest.doMock('../program/program.service', () => ({}));
      jest.doMock('@nestjs/core', () => ({}));
      jest.doMock('./mcp-auth.service', () => ({}));
      jest.doMock('./mcp-registry.service', () => ({}));
      const { McpController } = require('./mcp.controller');
      jest.dontMock('./mcp-auth.service');
      jest.dontMock('./mcp-registry.service');
      const { McpAuthService } = require('./mcp-auth.service');
      const { McpRegistry } = require('./mcp-registry.service');
      const { McpActionExecutor } = require('./mcp-action.executor');
      expect(Reflect.getMetadata('design:paramtypes', McpController)).toEqual([
        Object,
        Object,
      ]);
      expect(Reflect.getMetadata('design:paramtypes', McpAuthService)).toEqual([
        Object,
        Object,
        Object,
      ]);
      expect(Reflect.getMetadata('design:paramtypes', McpRegistry)).toEqual([
        Object,
        Object,
        Object,
        Object,
        Object,
      ]);
      expect(
        Reflect.getMetadata('design:paramtypes', McpActionExecutor),
      ).toEqual([Object, Object]);
    });
  });
});
