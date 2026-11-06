describe('SongExecutionEngine constructor metadata', () => {
  it('records Object for the optional similarity dependency when its module is not yet loaded', () => {
    jest.isolateModules(() => {
      jest.doMock('./song-similarity.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { SongExecutionEngine } = require('./song-execution.engine') as {
        SongExecutionEngine: new (...args: never[]) => unknown;
      };
      const types = Reflect.getMetadata(
        'design:paramtypes',
        SongExecutionEngine,
      ) as unknown[];
      expect(types[5]).toBe(Object);
    });
    jest.dontMock('./song-similarity.service');
  });
});
