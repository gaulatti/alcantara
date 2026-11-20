/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- modules are loaded inside jest.isolateModules with their dependencies mocked away. */
describe('song, media, asset and similarity provider decorator metadata under unresolved circular imports', () => {
  it('records Object for dependencies whose modules are not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('../../songs/songs.service', () => ({}));
      jest.doMock('../../media/media.service', () => ({}));
      jest.doMock('../../media-assets/media-assets.service', () => ({}));
      jest.doMock('../../radio/song-similarity.service', () => ({}));
      jest.doMock('../../program/program.service', () => ({}));
      const { SongsMcpTools } = require('./songs');
      const { MediaMcpTools } = require('./media');
      const { MediaAssetsMcpTools } = require('./media-assets');
      const { SimilarityMcpTools } = require('./similarity');
      for (const provider of [
        SongsMcpTools,
        MediaMcpTools,
        MediaAssetsMcpTools,
        SimilarityMcpTools,
      ])
        expect(Reflect.getMetadata('design:paramtypes', provider)).toEqual([
          Object,
        ]);
    });
  });
});
