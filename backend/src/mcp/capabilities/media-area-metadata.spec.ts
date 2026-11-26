/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- modules are loaded inside jest.isolateModules with their dependencies mocked away. */
describe('song, media, asset and similarity provider decorator metadata under unresolved circular imports', () => {
  it('records Object for dependencies whose modules are not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('../../songs/songs.service', () => ({}));
      jest.doMock('../../media/media.service', () => ({}));
      jest.doMock('../../media-assets/media-assets.service', () => ({}));
      jest.doMock('../../radio/song-similarity.service', () => ({}));
      jest.doMock('../../program/program.service', () => ({}));
      jest.doMock('../../auth/pompeii.service', () => ({}));
      const { SongsMcpTools } = require('./songs');
      const { MediaMcpTools } = require('./media');
      const { MediaAssetsMcpTools } = require('./media-assets');
      const { SimilarityMcpTools } = require('./similarity');
      jest.doMock('../../uploads/uploads.service', () => ({}));
      const { MediaImportMcpTools } = require('./media-import');
      for (const provider of [MediaMcpTools, MediaAssetsMcpTools])
        expect(Reflect.getMetadata('design:paramtypes', provider)).toEqual([
          Object,
          Object,
          Object,
        ]);
      for (const provider of [SongsMcpTools])
        expect(Reflect.getMetadata('design:paramtypes', provider)).toEqual([
          Object,
          Object,
        ]);
      expect(
        Reflect.getMetadata('design:paramtypes', SimilarityMcpTools),
      ).toEqual([Object]);
      expect(
        Reflect.getMetadata('design:paramtypes', MediaImportMcpTools),
      ).toEqual([Object]);
    });
  });
});
