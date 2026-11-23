/* eslint-disable @typescript-eslint/no-require-imports */
describe('ArtistLabelsMcpTools decorator metadata', () => {
  afterEach(() => jest.resetModules());

  it('falls back to Object when collaborator classes are undefined at decoration time', () => {
    jest.isolateModules(() => {
      jest.doMock('../../artist-labels/artist-labels.service', () => ({
        ArtistLabelsService: undefined,
      }));
      jest.doMock('../../auth/pompeii.service', () => ({
        PompeiiService: undefined,
      }));
      const { ArtistLabelsMcpTools } = require('./artist-labels') as {
        ArtistLabelsMcpTools: new (...args: never[]) => unknown;
      };
      expect(
        Reflect.getMetadata('design:paramtypes', ArtistLabelsMcpTools),
      ).toEqual([Object, Object]);
    });
  });
});
