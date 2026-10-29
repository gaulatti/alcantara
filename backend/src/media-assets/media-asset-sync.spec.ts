import { MediaAssetKind, MediaAssetType } from '@prisma/client';
import {
  deleteMediaAsset,
  deleteSongCoverAsset,
  mediaAssetId,
  songCoverAssetId,
  syncAudioClipAsset,
  syncImageAsset,
  syncSongAsset,
  syncTransitionAsset,
} from './media-asset-sync';

function buildTransaction() {
  return {
    mediaAsset: { upsert: jest.fn(), deleteMany: jest.fn() },
    media: { update: jest.fn() },
    instant: { update: jest.fn() },
    song: { update: jest.fn() },
    stinger: { update: jest.fn() },
  };
}

describe('media asset synchronization', () => {
  it('uses deterministic IDs for every bounded media kind', () => {
    expect(mediaAssetId(MediaAssetKind.IMAGE, 3)).toBe('image:3');
    expect(mediaAssetId(MediaAssetKind.AUDIO_CLIP, 4)).toBe('audio-clip:4');
    expect(mediaAssetId(MediaAssetKind.SONG, 5)).toBe('song:5');
    expect(mediaAssetId(MediaAssetKind.TRANSITION, 6)).toBe('transition:6');
    expect(songCoverAssetId(5)).toBe('song-cover:5');
  });

  it('maps and links every legacy media record into the common registry', async () => {
    const tx = buildTransaction();

    await syncImageAsset(tx as never, {
      id: 1,
      name: 'Still',
      imageUrl: 'https://media.test/still.jpg',
    });
    await syncAudioClipAsset(tx as never, {
      id: 2,
      name: 'Bumper',
      audioUrl: 'https://media.test/bumper.mp3',
      enabled: false,
    });
    await syncSongAsset(tx as never, {
      id: 3,
      artist: 'Artist',
      title: '',
      audioUrl: 'https://media.test/song.mp3',
      enabled: true,
    });
    await syncTransitionAsset(tx as never, {
      id: 4,
      name: 'Wipe',
      videoUrl: 'https://media.test/wipe.webm',
      enabled: true,
    });

    expect(tx.mediaAsset.upsert.mock.calls).toEqual([
      [
        {
          where: { id: 'image:1' },
          create: {
            id: 'image:1',
            kind: MediaAssetKind.IMAGE,
            mediaType: MediaAssetType.IMAGE,
            name: 'Still',
            sourceUrl: 'https://media.test/still.jpg',
            enabled: true,
          },
          update: {
            kind: MediaAssetKind.IMAGE,
            mediaType: MediaAssetType.IMAGE,
            name: 'Still',
            sourceUrl: 'https://media.test/still.jpg',
            enabled: true,
          },
        },
      ],
      [
        {
          where: { id: 'audio-clip:2' },
          create: {
            id: 'audio-clip:2',
            kind: MediaAssetKind.AUDIO_CLIP,
            mediaType: MediaAssetType.AUDIO,
            name: 'Bumper',
            sourceUrl: 'https://media.test/bumper.mp3',
            enabled: false,
          },
          update: {
            kind: MediaAssetKind.AUDIO_CLIP,
            mediaType: MediaAssetType.AUDIO,
            name: 'Bumper',
            sourceUrl: 'https://media.test/bumper.mp3',
            enabled: false,
          },
        },
      ],
      [
        {
          where: { id: 'song:3' },
          create: {
            id: 'song:3',
            kind: MediaAssetKind.SONG,
            mediaType: MediaAssetType.AUDIO,
            name: 'Artist',
            sourceUrl: 'https://media.test/song.mp3',
            enabled: true,
          },
          update: {
            kind: MediaAssetKind.SONG,
            mediaType: MediaAssetType.AUDIO,
            name: 'Artist',
            sourceUrl: 'https://media.test/song.mp3',
            enabled: true,
          },
        },
      ],
      [
        {
          where: { id: 'transition:4' },
          create: {
            id: 'transition:4',
            kind: MediaAssetKind.TRANSITION,
            mediaType: MediaAssetType.VIDEO,
            name: 'Wipe',
            sourceUrl: 'https://media.test/wipe.webm',
            enabled: true,
          },
          update: {
            kind: MediaAssetKind.TRANSITION,
            mediaType: MediaAssetType.VIDEO,
            name: 'Wipe',
            sourceUrl: 'https://media.test/wipe.webm',
            enabled: true,
          },
        },
      ],
    ]);
    expect(tx.media.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { assetId: 'image:1' },
    });
    expect(tx.instant.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: { assetId: 'audio-clip:2' },
    });
    expect(tx.song.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: { assetId: 'song:3', coverAssetId: null },
    });
    expect(tx.stinger.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: { assetId: 'transition:4' },
    });
  });

  it('registers song artwork as a separate image asset without changing the audio asset', async () => {
    const tx = buildTransaction();

    await syncSongAsset(tx as never, {
      id: 9,
      artist: 'Artist',
      title: 'Title',
      audioUrl: 'https://media.test/song.mp3',
      coverUrl: 'https://media.test/cover.jpg',
      enabled: true,
    });

    expect(tx.mediaAsset.upsert).toHaveBeenNthCalledWith(1, {
      where: { id: 'song:9' },
      create: expect.objectContaining({
        id: 'song:9',
        mediaType: MediaAssetType.AUDIO,
        sourceUrl: 'https://media.test/song.mp3',
      }),
      update: expect.objectContaining({
        mediaType: MediaAssetType.AUDIO,
        sourceUrl: 'https://media.test/song.mp3',
      }),
    });
    expect(tx.mediaAsset.upsert).toHaveBeenNthCalledWith(2, {
      where: { id: 'song-cover:9' },
      create: expect.objectContaining({
        id: 'song-cover:9',
        kind: null,
        mediaType: MediaAssetType.IMAGE,
        sourceUrl: 'https://media.test/cover.jpg',
      }),
      update: expect.objectContaining({
        mediaType: MediaAssetType.IMAGE,
        sourceUrl: 'https://media.test/cover.jpg',
      }),
    });
    expect(tx.song.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { assetId: 'song:9', coverAssetId: 'song-cover:9' },
    });
  });

  it('removes exactly the registry row owned by a deleted legacy record', async () => {
    const tx = buildTransaction();

    await deleteMediaAsset(tx as never, MediaAssetKind.SONG, 19);

    expect(tx.mediaAsset.deleteMany).toHaveBeenCalledWith({
      where: { id: 'song:19' },
    });
  });

  it('preserves the legacy timestamps during deployment-gap reconciliation', async () => {
    const tx = buildTransaction();
    const createdAt = new Date('2026-09-01T10:00:00.000Z');
    const updatedAt = new Date('2026-09-12T11:30:00.000Z');

    await syncImageAsset(tx as never, {
      id: 21,
      assetId: 'image:21',
      name: 'Archive still',
      imageUrl: 'https://media.test/archive.jpg',
      createdAt,
      updatedAt,
    });

    expect(tx.mediaAsset.upsert).toHaveBeenCalledWith({
      where: { id: 'image:21' },
      create: {
        id: 'image:21',
        kind: MediaAssetKind.IMAGE,
        mediaType: MediaAssetType.IMAGE,
        name: 'Archive still',
        sourceUrl: 'https://media.test/archive.jpg',
        enabled: true,
        createdAt,
        updatedAt,
      },
      update: {
        kind: MediaAssetKind.IMAGE,
        mediaType: MediaAssetType.IMAGE,
        name: 'Archive still',
        sourceUrl: 'https://media.test/archive.jpg',
        enabled: true,
        updatedAt,
      },
    });
    expect(tx.media.update).not.toHaveBeenCalled();
  });

  describe('source timestamps and existing links', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const updatedAt = new Date('2026-02-02T00:00:00.000Z');

    it('preserves legacy timestamps on the registry rows and the back-link', async () => {
      const tx = buildTransaction();
      await syncImageAsset(tx as never, {
        id: 1,
        name: 'Still',
        imageUrl: 'https://media.test/still.jpg',
        createdAt,
        updatedAt,
      });
      await syncAudioClipAsset(tx as never, {
        id: 2,
        name: 'Bumper',
        audioUrl: 'https://media.test/bumper.mp3',
        enabled: true,
        createdAt,
        updatedAt,
      });
      await syncTransitionAsset(tx as never, {
        id: 4,
        name: 'Wipe',
        videoUrl: 'https://media.test/wipe.webm',
        enabled: true,
        createdAt,
        updatedAt,
      });

      const upserts = tx.mediaAsset.upsert.mock.calls as unknown as [
        { create: Record<string, unknown>; update: Record<string, unknown> },
      ][];
      expect(upserts).toHaveLength(3);
      for (const [call] of upserts) {
        expect(call.create).toMatchObject({ createdAt, updatedAt });
        expect(call.update).toMatchObject({ updatedAt });
        expect(call.update).not.toHaveProperty('createdAt');
      }
      expect(tx.media.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { assetId: 'image:1', updatedAt },
      });
      expect(tx.instant.update).toHaveBeenCalledWith({
        where: { id: 2 },
        data: { assetId: 'audio-clip:2', updatedAt },
      });
      expect(tx.stinger.update).toHaveBeenCalledWith({
        where: { id: 4 },
        data: { assetId: 'transition:4', updatedAt },
      });
    });

    it('does not rewrite back-links that already point at the registry row', async () => {
      const tx = buildTransaction();
      await syncImageAsset(tx as never, {
        id: 1,
        assetId: 'image:1',
        name: 'Still',
        imageUrl: 'https://media.test/still.jpg',
      });
      await syncAudioClipAsset(tx as never, {
        id: 2,
        assetId: 'audio-clip:2',
        name: 'Bumper',
        audioUrl: 'https://media.test/bumper.mp3',
        enabled: true,
      });
      await syncTransitionAsset(tx as never, {
        id: 4,
        assetId: 'transition:4',
        name: 'Wipe',
        videoUrl: 'https://media.test/wipe.webm',
        enabled: true,
      });
      await syncSongAsset(tx as never, {
        id: 3,
        assetId: 'song:3',
        coverAssetId: null,
        artist: 'Artist',
        title: 'Song',
        audioUrl: 'https://media.test/song.mp3',
        enabled: true,
      });

      expect(tx.mediaAsset.upsert).toHaveBeenCalledTimes(4);
      expect(tx.media.update).not.toHaveBeenCalled();
      expect(tx.instant.update).not.toHaveBeenCalled();
      expect(tx.stinger.update).not.toHaveBeenCalled();
      expect(tx.song.update).not.toHaveBeenCalled();
      expect(tx.mediaAsset.deleteMany).not.toHaveBeenCalled();
    });

    it('carries song and cover timestamps and keeps an already linked cover untouched', async () => {
      const tx = buildTransaction();
      await syncSongAsset(tx as never, {
        id: 9,
        assetId: 'song:9',
        coverAssetId: 'song-cover:9',
        artist: ' Artist ',
        title: ' Title ',
        audioUrl: 'https://media.test/song.mp3',
        coverUrl: ' https://media.test/cover.jpg ',
        enabled: true,
        createdAt,
        updatedAt,
      });

      expect(tx.mediaAsset.upsert).toHaveBeenNthCalledWith(2, {
        where: { id: 'song-cover:9' },
        create: {
          id: 'song-cover:9',
          kind: null,
          mediaType: MediaAssetType.IMAGE,
          name: 'Artist Title cover',
          sourceUrl: 'https://media.test/cover.jpg',
          enabled: true,
          createdAt,
          updatedAt,
        },
        update: {
          mediaType: MediaAssetType.IMAGE,
          name: 'Artist Title cover',
          sourceUrl: 'https://media.test/cover.jpg',
          enabled: true,
          updatedAt,
        },
      });
      expect(tx.song.update).not.toHaveBeenCalled();
    });

    it('stamps the song update time on a new link and removes a cover whose url was cleared', async () => {
      const tx = buildTransaction();
      await syncSongAsset(tx as never, {
        id: 9,
        assetId: null,
        coverAssetId: 'song-cover:9',
        artist: 'Artist',
        title: 'Title',
        audioUrl: 'https://media.test/song.mp3',
        coverUrl: '   ',
        enabled: true,
        updatedAt,
      });

      expect(tx.song.update).toHaveBeenCalledWith({
        where: { id: 9 },
        data: { assetId: 'song:9', coverAssetId: null, updatedAt },
      });
      expect(tx.mediaAsset.deleteMany).toHaveBeenCalledWith({
        where: { id: 'song-cover:9' },
      });
    });

    it('deletes song covers explicitly', async () => {
      const tx = buildTransaction();
      await deleteSongCoverAsset(tx as never, 9);
      expect(tx.mediaAsset.deleteMany).toHaveBeenCalledWith({
        where: { id: 'song-cover:9' },
      });
    });
  });
});
