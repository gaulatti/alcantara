import { ForbiddenException } from '@nestjs/common';
import { MediaAssetType } from '@prisma/client';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import {
  assertCanManageLabels,
  assertCanManageBackgroundAudio,
  assertCanManageMediaAsset,
  canManageMediaAsset,
  readableMediaAssetWhere,
} from './media-asset-authorization';

describe('media asset authorization', () => {
  it('limits catalog reads to capabilities granted to the operator', () => {
    expect(
      readableMediaAssetWhere([
        ALCANTARA_PERMISSIONS.song.read,
        ALCANTARA_PERMISSIONS.scene.read,
      ]),
    ).toEqual({
      OR: [{ backgroundAudio: { isNot: null } }, { song: { isNot: null } }],
    });
  });

  it('does not let one capability grant access to unrelated audio assets', () => {
    const song = {
      mediaType: MediaAssetType.AUDIO,
      song: { id: 4 },
    };
    const instant = {
      mediaType: MediaAssetType.AUDIO,
      audioClip: { id: 7 },
    };

    expect(canManageMediaAsset(song, [ALCANTARA_PERMISSIONS.song.manage])).toBe(
      true,
    );
    expect(
      canManageMediaAsset(instant, [ALCANTARA_PERMISSIONS.song.manage]),
    ).toBe(false);
    expect(() =>
      assertCanManageMediaAsset(instant, [ALCANTARA_PERMISSIONS.song.manage]),
    ).toThrow(ForbiddenException);
  });

  it('allows label management only to an existing media capability manager', () => {
    expect(() =>
      assertCanManageLabels([ALCANTARA_PERMISSIONS.media.read]),
    ).toThrow(ForbiddenException);
    expect(() =>
      assertCanManageLabels([ALCANTARA_PERMISSIONS.media.manage]),
    ).not.toThrow();
  });

  it('keeps background capability writes behind scene management', () => {
    expect(() =>
      assertCanManageBackgroundAudio([ALCANTARA_PERMISSIONS.song.manage]),
    ).toThrow(ForbiddenException);
    expect(() =>
      assertCanManageBackgroundAudio([ALCANTARA_PERMISSIONS.scene.manage]),
    ).not.toThrow();
  });
});
