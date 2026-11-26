/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- modules are loaded inside jest.isolateModules with their dependencies mocked away. */
describe('flight capability provider decorator metadata under unresolved circular imports', () => {
  it('records Object for dependencies whose modules are not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('../../program/flight.service', () => ({}));
      jest.doMock('../../program/program.service', () => ({}));
      jest.doMock('../../radio/radio.service', () => ({}));
      const { FlightMcpTools } = require('./flight');
      expect(Reflect.getMetadata('design:paramtypes', FlightMcpTools)).toEqual([
        Object,
        Object,
        Object,
      ]);
    });
  });
});
