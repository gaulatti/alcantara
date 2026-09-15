import { ForbiddenException } from '@nestjs/common';
import { MediaAssetType, Prisma } from '@prisma/client';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';

export interface MediaAssetCapabilityShape {
  mediaType: MediaAssetType | null;
  audioClip?: unknown | null;
  backgroundAudio?: unknown | null;
  song?: unknown | null;
  transition?: unknown | null;
}

const MANAGE_PERMISSIONS = [
  ALCANTARA_PERMISSIONS.media.manage,
  ALCANTARA_PERMISSIONS.instant.manage,
  ALCANTARA_PERMISSIONS.song.manage,
  ALCANTARA_PERMISSIONS.stinger.manage,
  ALCANTARA_PERMISSIONS.scene.manage,
] as const;

function hasPermission(permissions: Set<string>, permission: string): boolean {
  return permissions.has('*') || permissions.has(permission);
}

export function readableMediaAssetWhere(
  effectivePermissions: string[],
): Prisma.MediaAssetWhereInput {
  const permissions = new Set(effectivePermissions);
  if (permissions.has('*')) return {};

  const allowed: Prisma.MediaAssetWhereInput[] = [];
  if (hasPermission(permissions, ALCANTARA_PERMISSIONS.media.read)) {
    allowed.push({ mediaType: MediaAssetType.IMAGE });
  }
  if (hasPermission(permissions, ALCANTARA_PERMISSIONS.instant.read)) {
    allowed.push({ audioClip: { isNot: null } });
  }
  if (hasPermission(permissions, ALCANTARA_PERMISSIONS.scene.read)) {
    allowed.push({ backgroundAudio: { isNot: null } });
  }
  if (hasPermission(permissions, ALCANTARA_PERMISSIONS.song.read)) {
    allowed.push({ song: { isNot: null } });
  }
  if (hasPermission(permissions, ALCANTARA_PERMISSIONS.stinger.read)) {
    allowed.push({ transition: { isNot: null } });
  }

  return allowed.length > 0
    ? { OR: allowed }
    : { id: '__no_authorized_media_asset__' };
}

export function canManageMediaAsset(
  asset: MediaAssetCapabilityShape,
  effectivePermissions: string[],
): boolean {
  const permissions = new Set(effectivePermissions);
  if (permissions.has('*')) return true;
  if (
    asset.mediaType === MediaAssetType.IMAGE &&
    hasPermission(permissions, ALCANTARA_PERMISSIONS.media.manage)
  ) {
    return true;
  }
  if (
    asset.audioClip &&
    hasPermission(permissions, ALCANTARA_PERMISSIONS.instant.manage)
  ) {
    return true;
  }
  if (
    asset.backgroundAudio &&
    hasPermission(permissions, ALCANTARA_PERMISSIONS.scene.manage)
  ) {
    return true;
  }
  if (
    asset.song &&
    hasPermission(permissions, ALCANTARA_PERMISSIONS.song.manage)
  ) {
    return true;
  }
  return Boolean(
    asset.transition &&
    hasPermission(permissions, ALCANTARA_PERMISSIONS.stinger.manage),
  );
}

export function assertCanManageMediaAsset(
  asset: MediaAssetCapabilityShape,
  effectivePermissions: string[],
): void {
  if (!canManageMediaAsset(asset, effectivePermissions)) {
    throw new ForbiddenException({ error: 'MEDIA_ASSET_MANAGE_FORBIDDEN' });
  }
}

export function assertCanManageLabels(effectivePermissions: string[]): void {
  const permissions = new Set(effectivePermissions);
  if (
    !permissions.has('*') &&
    !MANAGE_PERMISSIONS.some((permission) => permissions.has(permission))
  ) {
    throw new ForbiddenException({ error: 'MEDIA_LABEL_MANAGE_FORBIDDEN' });
  }
}

export function assertCanManageBackgroundAudio(
  effectivePermissions: string[],
): void {
  const permissions = new Set(effectivePermissions);
  if (
    !permissions.has('*') &&
    !permissions.has(ALCANTARA_PERMISSIONS.scene.manage)
  ) {
    throw new ForbiddenException({
      error: 'BACKGROUND_AUDIO_MANAGE_FORBIDDEN',
    });
  }
}
