describe('AppController design metadata under unresolved circular imports', () => {
  it('records Object for the constructor dependency when AppService is not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('./app.service', () => ({}));
      const { AppController } = require('./app.controller');
      expect(Reflect.getMetadata('design:paramtypes', AppController)).toEqual([
        Object,
      ]);
    });
  });
});
