import { ForbiddenException } from '@nestjs/common';
import { MediaAssetType } from '@prisma/client';
import { ALCANTARA_PERMISSIONS as permissions } from '../auth/permissions';
import {
  assertCanManageBackgroundAudio,
  assertCanManageLabels,
  assertCanManageMediaAsset,
  canManageMediaAsset,
  readableMediaAssetWhere,
  type MediaAssetCapabilityShape,
} from './media-asset-authorization';

const capabilities = [
  [
    'image',
    { mediaType: MediaAssetType.IMAGE },
    permissions.media,
    { mediaType: MediaAssetType.IMAGE },
  ],
  [
    'clip',
    { mediaType: MediaAssetType.AUDIO, audioClip: { id: 1 } },
    permissions.instant,
    { audioClip: { isNot: null } },
  ],
  [
    'background',
    { mediaType: MediaAssetType.AUDIO, backgroundAudio: { id: 2 } },
    permissions.scene,
    { backgroundAudio: { isNot: null } },
  ],
  [
    'song',
    { mediaType: MediaAssetType.AUDIO, song: { id: 3 } },
    permissions.song,
    { song: { isNot: null } },
  ],
  [
    'transition',
    { mediaType: MediaAssetType.VIDEO, transition: { id: 4 } },
    permissions.stinger,
    { transition: { isNot: null } },
  ],
] as const;

describe('independent media capability authorization boundaries', () => {
  it.each(capabilities)(
    'grants only the matching %s read filter and management capability',
    (_name, asset, capability, filter) => {
      expect(readableMediaAssetWhere([capability.read])).toEqual({
        OR: [filter],
      });
      expect(canManageMediaAsset(asset, [capability.manage])).toBe(true);
      expect(() =>
        assertCanManageMediaAsset(asset, [capability.manage]),
      ).not.toThrow();
      expect(canManageMediaAsset(asset, [capability.read])).toBe(false);
      expect(() => assertCanManageMediaAsset(asset, [capability.read])).toThrow(
        ForbiddenException,
      );
      for (const other of capabilities) {
        if (other[0] !== _name)
          expect(canManageMediaAsset(asset, [other[2].manage])).toBe(false);
      }
    },
  );

  it('retains broad access only for explicit wildcard authority and denies an empty capability set', () => {
    expect(readableMediaAssetWhere(['*'])).toEqual({});
    expect(readableMediaAssetWhere([])).toEqual({
      id: '__no_authorized_media_asset__',
    });
    expect(canManageMediaAsset({ mediaType: null }, [])).toBe(false);
    expect(canManageMediaAsset({ mediaType: null }, ['*'])).toBe(true);
    expect(() => assertCanManageLabels(['*'])).not.toThrow();
    expect(() => assertCanManageBackgroundAudio(['*'])).not.toThrow();
  });

  it.each(capabilities)(
    'lets an actual %s manager maintain shared labels',
    (_name, _asset, capability) => {
      expect(() => assertCanManageLabels([capability.manage])).not.toThrow();
      expect(() => assertCanManageLabels([capability.read])).toThrow(
        ForbiddenException,
      );
    },
  );

  it('requires an actual attached capability, not just an audio/video media type', () => {
    const detached: MediaAssetCapabilityShape = {
      mediaType: MediaAssetType.AUDIO,
      audioClip: null,
      backgroundAudio: null,
      song: null,
      transition: null,
    };
    expect(
      canManageMediaAsset(
        detached,
        capabilities.map((entry) => entry[2].manage),
      ),
    ).toBe(false);
    try {
      assertCanManageMediaAsset(detached, [permissions.song.manage]);
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toEqual({
        error: 'MEDIA_ASSET_MANAGE_FORBIDDEN',
      });
    }
  });

  it('does not confuse background scene authority with any other media management permission', () => {
    for (const [, , capability] of capabilities) {
      if (capability.manage !== permissions.scene.manage)
        expect(() =>
          assertCanManageBackgroundAudio([capability.manage]),
        ).toThrow(ForbiddenException);
    }
    expect(() =>
      assertCanManageBackgroundAudio([permissions.scene.manage]),
    ).not.toThrow();
  });
});
