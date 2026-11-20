/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- modules are loaded inside jest.isolateModules with their dependencies mocked away. */
describe('capability provider decorator metadata under unresolved circular imports', () => {
  it('records Object for dependencies whose modules are not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('../../program/program.service', () => ({}));
      jest.doMock('../../scenes/scenes.service', () => ({}));
      jest.doMock('../../layouts/layouts.service', () => ({}));
      jest.doMock('../../media-groups/media-groups.service', () => ({}));
      const { ProgramMcpTools } = require('./program');
      const { ScenesMcpTools } = require('./scenes');
      const { LayoutsMcpTools } = require('./layouts');
      const { MediaGroupsMcpTools } = require('./media-groups');
      for (const provider of [
        ProgramMcpTools,
        ScenesMcpTools,
        LayoutsMcpTools,
        MediaGroupsMcpTools,
      ])
        expect(Reflect.getMetadata('design:paramtypes', provider)).toEqual([
          Object,
        ]);
    });
  });
});
