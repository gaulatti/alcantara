describe('RendererWriteGuard decorator metadata', () => {
  it('records Object for each dependency whose module is not loaded yet', () => {
    jest.isolateModules(() => {
      jest.doMock('@nestjs/core', () => ({
        ...jest.requireActual('@nestjs/core'),
        Reflector: undefined,
      }));
      jest.doMock('../auth/pompeii.service', () => ({}));
      jest.doMock('./renderer-auth.service', () => ({}));
      jest.doMock('../auth/test-auth.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { RendererWriteGuard: Isolated } =
        require('./renderer-write.guard') as {
          RendererWriteGuard: new (...args: never[]) => unknown;
        };
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
        Object,
        Object,
        Object,
      ]);
    });
    jest.dontMock('@nestjs/core');
    jest.dontMock('../auth/pompeii.service');
    jest.dontMock('./renderer-auth.service');
    jest.dontMock('../auth/test-auth.service');
  });
});
