import { MediaAssetKind, MediaAssetType } from '@prisma/client';
import {
  deleteMediaAsset,
  deleteSongCoverAsset,
  syncAudioClipAsset,
  syncImageAsset,
  syncSongAsset,
  syncTransitionAsset,
} from './media-asset-sync';

function buildTx() {
  return {
    mediaAsset: { upsert: jest.fn(), deleteMany: jest.fn() },
    media: { update: jest.fn() },
    instant: { update: jest.fn() },
    song: { update: jest.fn() },
    stinger: { update: jest.fn() },
  };
}

const created = new Date('2026-01-01T00:00:00Z');
const updated = new Date('2026-02-01T00:00:00Z');

describe('media asset sync (coverage)', () => {
  it('propagates createdAt/updatedAt for images and links the legacy row', async () => {
    const tx = buildTx();
    await expect(
      syncImageAsset(tx as never, {
        id: 1,
        assetId: null,
        name: 'Still',
        imageUrl: 'u',
        createdAt: created,
        updatedAt: updated,
      }),
    ).resolves.toBe('image:1');

    expect(tx.mediaAsset.upsert).toHaveBeenCalledWith({
      where: { id: 'image:1' },
      create: {
        id: 'image:1',
        kind: MediaAssetKind.IMAGE,
        mediaType: MediaAssetType.IMAGE,
        name: 'Still',
        sourceUrl: 'u',
        enabled: true,
        createdAt: created,
        updatedAt: updated,
      },
      update: {
        kind: MediaAssetKind.IMAGE,
        mediaType: MediaAssetType.IMAGE,
        name: 'Still',
        sourceUrl: 'u',
        enabled: true,
        updatedAt: updated,
      },
    });
    expect(tx.media.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { assetId: 'image:1', updatedAt: updated },
    });
  });

  it('does not rewrite an image whose asset link is already correct', async () => {
    const tx = buildTx();
    await syncImageAsset(tx as never, {
      id: 1,
      assetId: 'image:1',
      name: 'Still',
      imageUrl: 'u',
    });
    expect(tx.media.update).not.toHaveBeenCalled();
  });

  it('links an image without updatedAt using only the asset id', async () => {
    const tx = buildTx();
    await syncImageAsset(tx as never, {
      id: 2,
      name: 'Still',
      imageUrl: 'u',
    });
    expect(tx.media.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: { assetId: 'image:2' },
    });
  });

  it('syncs audio clips with and without updatedAt', async () => {
    const tx = buildTx();
    await syncAudioClipAsset(tx as never, {
      id: 2,
      assetId: 'old',
      name: 'Bump',
      audioUrl: 'a',
      enabled: true,
      updatedAt: updated,
    });
    await syncAudioClipAsset(tx as never, {
      id: 3,
      assetId: null,
      name: 'Bump',
      audioUrl: 'a',
      enabled: true,
    });
    await syncAudioClipAsset(tx as never, {
      id: 4,
      assetId: 'audio-clip:4',
      name: 'Bump',
      audioUrl: 'a',
      enabled: true,
    });
    expect(tx.instant.update.mock.calls).toEqual([
      [
        {
          where: { id: 2 },
          data: { assetId: 'audio-clip:2', updatedAt: updated },
        },
      ],
      [{ where: { id: 3 }, data: { assetId: 'audio-clip:3' } }],
    ]);
  });

  it('syncs transitions with and without updatedAt', async () => {
    const tx = buildTx();
    await syncTransitionAsset(tx as never, {
      id: 2,
      assetId: null,
      name: 'Wipe',
      videoUrl: 'v',
      enabled: false,
      updatedAt: updated,
    });
    await syncTransitionAsset(tx as never, {
      id: 3,
      assetId: null,
      name: 'Wipe',
      videoUrl: 'v',
      enabled: false,
    });
    await syncTransitionAsset(tx as never, {
      id: 4,
      assetId: 'transition:4',
      name: 'Wipe',
      videoUrl: 'v',
      enabled: false,
    });
    expect(tx.stinger.update.mock.calls).toEqual([
      [
        {
          where: { id: 2 },
          data: { assetId: 'transition:2', updatedAt: updated },
        },
      ],
      [{ where: { id: 3 }, data: { assetId: 'transition:3' } }],
    ]);
  });

  describe('songs', () => {
    const baseSong = {
      id: 7,
      artist: ' Artist ',
      title: ' Title ',
      audioUrl: 'a',
      enabled: true,
    };

    it('writes a cover asset with timestamps and relinks the song', async () => {
      const tx = buildTx();
      await expect(
        syncSongAsset(tx as never, {
          ...baseSong,
          assetId: null,
          coverAssetId: null,
          coverUrl: ' c ',
          createdAt: created,
          updatedAt: updated,
        }),
      ).resolves.toBe('song:7');

      expect(tx.mediaAsset.upsert).toHaveBeenNthCalledWith(2, {
        where: { id: 'song-cover:7' },
        create: {
          id: 'song-cover:7',
          kind: null,
          mediaType: MediaAssetType.IMAGE,
          name: 'Artist Title cover',
          sourceUrl: 'c',
          enabled: true,
          createdAt: created,
          updatedAt: updated,
        },
        update: {
          mediaType: MediaAssetType.IMAGE,
          name: 'Artist Title cover',
          sourceUrl: 'c',
          enabled: true,
          updatedAt: updated,
        },
      });
      expect(tx.song.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: {
          assetId: 'song:7',
          coverAssetId: 'song-cover:7',
          updatedAt: updated,
        },
      });
      expect(tx.mediaAsset.deleteMany).not.toHaveBeenCalled();
    });

    it('writes a cover asset without timestamps', async () => {
      const tx = buildTx();
      await syncSongAsset(tx as never, {
        ...baseSong,
        assetId: 'song:7',
        coverAssetId: 'song-cover:7',
        coverUrl: 'c',
      });
      const coverCall = tx.mediaAsset.upsert.mock.calls[1][0];
      expect(coverCall.create).not.toHaveProperty('createdAt');
      expect(coverCall.create).not.toHaveProperty('updatedAt');
      expect(coverCall.update).not.toHaveProperty('updatedAt');
      // links already correct -> no song update
      expect(tx.song.update).not.toHaveBeenCalled();
    });

    it('relinks when only the cover id differs, without updatedAt', async () => {
      const tx = buildTx();
      await syncSongAsset(tx as never, {
        ...baseSong,
        assetId: 'song:7',
        coverAssetId: null,
        coverUrl: 'c',
      });
      expect(tx.song.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: { assetId: 'song:7', coverAssetId: 'song-cover:7' },
      });
    });

    it('removes the cover asset when the cover url is blank', async () => {
      const tx = buildTx();
      await syncSongAsset(tx as never, {
        ...baseSong,
        title: '   ',
        assetId: 'song:7',
        coverAssetId: 'song-cover:7',
        coverUrl: '   ',
      });
      expect(tx.mediaAsset.upsert).toHaveBeenCalledTimes(1);
      expect(tx.mediaAsset.upsert.mock.calls[0][0].create.name).toBe('Artist');
      expect(tx.song.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: { assetId: 'song:7', coverAssetId: null },
      });
      expect(tx.mediaAsset.deleteMany).toHaveBeenCalledWith({
        where: { id: 'song-cover:7' },
      });
    });

    it('leaves everything alone when there is no cover and nothing to unlink', async () => {
      const tx = buildTx();
      await syncSongAsset(tx as never, {
        ...baseSong,
        assetId: 'song:7',
        coverAssetId: null,
        coverUrl: null,
      });
      expect(tx.song.update).not.toHaveBeenCalled();
      expect(tx.mediaAsset.deleteMany).not.toHaveBeenCalled();
    });
  });

  it('deletes assets by deterministic id', async () => {
    const tx = buildTx();
    await deleteMediaAsset(tx as never, MediaAssetKind.SONG, 3);
    await deleteSongCoverAsset(tx as never, 3);
    expect(tx.mediaAsset.deleteMany.mock.calls).toEqual([
      [{ where: { id: 'song:3' } }],
      [{ where: { id: 'song-cover:3' } }],
    ]);
  });
});
