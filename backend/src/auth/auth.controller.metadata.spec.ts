describe('AuthController design metadata under unresolved circular imports', () => {
  it('records Object for the ticket service dependency when its module is not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('./realtime-ticket.service', () => ({}));
      const { AuthController } = require('./auth.controller');
      expect(Reflect.getMetadata('design:paramtypes', AuthController)).toEqual([
        Object,
      ]);
    });
  });
});
