/* eslint-disable @typescript-eslint/no-require-imports */
describe('ArtistLabelsController decorator metadata', () => {
  afterEach(() => jest.resetModules());

  it('falls back to Object when the service class is undefined at decoration time', () => {
    jest.isolateModules(() => {
      jest.doMock('./artist-labels.service', () => ({
        ArtistLabelsService: undefined,
      }));
      const { ArtistLabelsController } =
        require('./artist-labels.controller') as {
          ArtistLabelsController: new (...args: never[]) => unknown;
        };
      expect(
        Reflect.getMetadata('design:paramtypes', ArtistLabelsController),
      ).toEqual([Object]);
    });
  });
});
