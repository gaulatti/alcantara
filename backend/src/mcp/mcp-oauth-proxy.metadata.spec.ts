/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- modules are loaded inside jest.isolateModules with their dependencies mocked away. */
// gaulatti/bastille#34: the sign-in proxy's Nest design metadata, as for the
// repo's other providers, when a constructor dependency is not yet defined
// (an unresolved circular import).
describe('MCP sign-in proxy design metadata under unresolved circular imports', () => {
  it('records Object for the controller dependency when the service is not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('./mcp-oauth-proxy.service', () => ({}));
      const {
        McpOAuthProxyController,
      } = require('./mcp-oauth-proxy.controller');
      expect(
        Reflect.getMetadata('design:paramtypes', McpOAuthProxyController),
      ).toEqual([Object]);
    });
  });

  it('records Object for the service dependency when the metrics service is not yet defined', () => {
    jest.isolateModules(() => {
      jest.unmock('./mcp-oauth-proxy.service');
      jest.doMock('../observability/managed-metrics.service', () => ({}));
      const { McpOAuthProxyService } = require('./mcp-oauth-proxy.service');
      expect(
        Reflect.getMetadata('design:paramtypes', McpOAuthProxyService),
      ).toEqual([Object]);
    });
  });
});
