import { MediaAssetKind, MediaAssetType } from '@prisma/client';
import {
  deleteMediaAsset,
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
});
