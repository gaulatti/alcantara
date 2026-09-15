import { MediaAssetKind, MediaAssetType, Prisma } from '@prisma/client';

const ASSET_ID_PREFIX: Record<MediaAssetKind, string> = {
  [MediaAssetKind.IMAGE]: 'image',
  [MediaAssetKind.AUDIO_CLIP]: 'audio-clip',
  [MediaAssetKind.SONG]: 'song',
  [MediaAssetKind.TRANSITION]: 'transition',
};

const ASSET_MEDIA_TYPE: Record<MediaAssetKind, MediaAssetType> = {
  [MediaAssetKind.IMAGE]: MediaAssetType.IMAGE,
  [MediaAssetKind.AUDIO_CLIP]: MediaAssetType.AUDIO,
  [MediaAssetKind.SONG]: MediaAssetType.AUDIO,
  [MediaAssetKind.TRANSITION]: MediaAssetType.VIDEO,
};

export interface MediaAssetSource {
  id: number;
  name: string;
  sourceUrl: string;
  enabled: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

type MediaAssetSyncClient = Pick<
  Prisma.TransactionClient,
  'mediaAsset' | 'media' | 'instant' | 'song' | 'stinger'
>;

export function mediaAssetId(kind: MediaAssetKind, legacyId: number): string {
  return `${ASSET_ID_PREFIX[kind]}:${legacyId}`;
}

export function songCoverAssetId(songId: number): string {
  return `song-cover:${songId}`;
}

async function upsertMediaAsset(
  tx: MediaAssetSyncClient,
  kind: MediaAssetKind,
  source: MediaAssetSource,
): Promise<string> {
  const assetId = mediaAssetId(kind, source.id);
  const asset = {
    kind,
    mediaType: ASSET_MEDIA_TYPE[kind],
    name: source.name,
    sourceUrl: source.sourceUrl,
    enabled: source.enabled,
  };
  const createTimestamps = {
    ...(source.createdAt ? { createdAt: source.createdAt } : {}),
    ...(source.updatedAt ? { updatedAt: source.updatedAt } : {}),
  };
  const updateTimestamp = source.updatedAt
    ? { updatedAt: source.updatedAt }
    : {};

  await tx.mediaAsset.upsert({
    where: { id: assetId },
    create: { id: assetId, ...asset, ...createTimestamps },
    update: { ...asset, ...updateTimestamp },
  });

  return assetId;
}

export async function syncImageAsset(
  tx: MediaAssetSyncClient,
  media: {
    id: number;
    assetId?: string | null;
    name: string;
    imageUrl: string;
    createdAt?: Date;
    updatedAt?: Date;
  },
): Promise<string> {
  const assetId = await upsertMediaAsset(tx, MediaAssetKind.IMAGE, {
    id: media.id,
    name: media.name,
    sourceUrl: media.imageUrl,
    enabled: true,
    createdAt: media.createdAt,
    updatedAt: media.updatedAt,
  });
  if (media.assetId !== assetId) {
    await tx.media.update({
      where: { id: media.id },
      data: {
        assetId,
        ...(media.updatedAt ? { updatedAt: media.updatedAt } : {}),
      },
    });
  }
  return assetId;
}

export async function syncAudioClipAsset(
  tx: MediaAssetSyncClient,
  instant: {
    id: number;
    assetId?: string | null;
    name: string;
    audioUrl: string;
    enabled: boolean;
    createdAt?: Date;
    updatedAt?: Date;
  },
): Promise<string> {
  const assetId = await upsertMediaAsset(tx, MediaAssetKind.AUDIO_CLIP, {
    id: instant.id,
    name: instant.name,
    sourceUrl: instant.audioUrl,
    enabled: instant.enabled,
    createdAt: instant.createdAt,
    updatedAt: instant.updatedAt,
  });
  if (instant.assetId !== assetId) {
    await tx.instant.update({
      where: { id: instant.id },
      data: {
        assetId,
        ...(instant.updatedAt ? { updatedAt: instant.updatedAt } : {}),
      },
    });
  }
  return assetId;
}

export async function syncSongAsset(
  tx: MediaAssetSyncClient,
  song: {
    id: number;
    assetId?: string | null;
    coverAssetId?: string | null;
    artist: string;
    title: string;
    audioUrl: string;
    coverUrl?: string | null;
    enabled: boolean;
    createdAt?: Date;
    updatedAt?: Date;
  },
): Promise<string> {
  const assetId = await upsertMediaAsset(tx, MediaAssetKind.SONG, {
    id: song.id,
    name: song.title.trim() || song.artist.trim(),
    sourceUrl: song.audioUrl,
    enabled: song.enabled,
    createdAt: song.createdAt,
    updatedAt: song.updatedAt,
  });
  const normalizedCoverUrl = song.coverUrl?.trim() || null;
  const coverAssetId = normalizedCoverUrl ? songCoverAssetId(song.id) : null;
  if (normalizedCoverUrl && coverAssetId) {
    await tx.mediaAsset.upsert({
      where: { id: coverAssetId },
      create: {
        id: coverAssetId,
        kind: null,
        mediaType: MediaAssetType.IMAGE,
        name: `${song.artist.trim()} ${song.title.trim()}`.trim() + ' cover',
        sourceUrl: normalizedCoverUrl,
        enabled: song.enabled,
        ...(song.createdAt ? { createdAt: song.createdAt } : {}),
        ...(song.updatedAt ? { updatedAt: song.updatedAt } : {}),
      },
      update: {
        mediaType: MediaAssetType.IMAGE,
        name: `${song.artist.trim()} ${song.title.trim()}`.trim() + ' cover',
        sourceUrl: normalizedCoverUrl,
        enabled: song.enabled,
        ...(song.updatedAt ? { updatedAt: song.updatedAt } : {}),
      },
    });
  }
  if (song.assetId !== assetId || song.coverAssetId !== coverAssetId) {
    await tx.song.update({
      where: { id: song.id },
      data: {
        assetId,
        coverAssetId,
        ...(song.updatedAt ? { updatedAt: song.updatedAt } : {}),
      },
    });
  }
  if (!coverAssetId && song.coverAssetId) {
    await tx.mediaAsset.deleteMany({
      where: { id: songCoverAssetId(song.id) },
    });
  }
  return assetId;
}

export async function syncTransitionAsset(
  tx: MediaAssetSyncClient,
  stinger: {
    id: number;
    assetId?: string | null;
    name: string;
    videoUrl: string;
    enabled: boolean;
    createdAt?: Date;
    updatedAt?: Date;
  },
): Promise<string> {
  const assetId = await upsertMediaAsset(tx, MediaAssetKind.TRANSITION, {
    id: stinger.id,
    name: stinger.name,
    sourceUrl: stinger.videoUrl,
    enabled: stinger.enabled,
    createdAt: stinger.createdAt,
    updatedAt: stinger.updatedAt,
  });
  if (stinger.assetId !== assetId) {
    await tx.stinger.update({
      where: { id: stinger.id },
      data: {
        assetId,
        ...(stinger.updatedAt ? { updatedAt: stinger.updatedAt } : {}),
      },
    });
  }
  return assetId;
}

export async function deleteMediaAsset(
  tx: MediaAssetSyncClient,
  kind: MediaAssetKind,
  legacyId: number,
): Promise<void> {
  await tx.mediaAsset.deleteMany({
    where: { id: mediaAssetId(kind, legacyId) },
  });
}

export async function deleteSongCoverAsset(
  tx: MediaAssetSyncClient,
  songId: number,
): Promise<void> {
  await tx.mediaAsset.deleteMany({ where: { id: songCoverAssetId(songId) } });
}
