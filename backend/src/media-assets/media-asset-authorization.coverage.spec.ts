import { ForbiddenException } from '@nestjs/common';
import { MediaAssetType } from '@prisma/client';
import { ALCANTARA_PERMISSIONS as P } from '../auth/permissions';
import {
  assertCanManageBackgroundAudio,
  assertCanManageLabels,
  assertCanManageMediaAsset,
  canManageMediaAsset,
  readableMediaAssetWhere,
} from './media-asset-authorization';

describe('media asset authorization (coverage)', () => {
  describe('readableMediaAssetWhere', () => {
    it('returns an unrestricted filter for wildcard permission', () => {
      expect(readableMediaAssetWhere(['*'])).toEqual({});
    });

    it('maps every read permission to its capability filter in order', () => {
      expect(
        readableMediaAssetWhere([
          P.media.read,
          P.instant.read,
          P.scene.read,
          P.song.read,
          P.stinger.read,
        ]),
      ).toEqual({
        OR: [
          { mediaType: MediaAssetType.IMAGE },
          { audioClip: { isNot: null } },
          { backgroundAudio: { isNot: null } },
          { song: { isNot: null } },
          { transition: { isNot: null } },
        ],
      });
    });

    it('grants each capability on its own', () => {
      expect(readableMediaAssetWhere([P.media.read])).toEqual({
        OR: [{ mediaType: MediaAssetType.IMAGE }],
      });
      expect(readableMediaAssetWhere([P.instant.read])).toEqual({
        OR: [{ audioClip: { isNot: null } }],
      });
      expect(readableMediaAssetWhere([P.stinger.read])).toEqual({
        OR: [{ transition: { isNot: null } }],
      });
    });

    it('matches nothing when no read permission applies', () => {
      expect(readableMediaAssetWhere([P.media.manage])).toEqual({
        id: '__no_authorized_media_asset__',
      });
      expect(readableMediaAssetWhere([])).toEqual({
        id: '__no_authorized_media_asset__',
      });
    });
  });

  describe('canManageMediaAsset', () => {
    it('allows everything for wildcard', () => {
      expect(canManageMediaAsset({ mediaType: null }, ['*'])).toBe(true);
    });

    it('allows image managers on images only', () => {
      const image = { mediaType: MediaAssetType.IMAGE };
      expect(canManageMediaAsset(image, [P.media.manage])).toBe(true);
      expect(canManageMediaAsset(image, [P.media.read])).toBe(false);
      expect(
        canManageMediaAsset({ mediaType: MediaAssetType.AUDIO }, [
          P.media.manage,
        ]),
      ).toBe(false);
    });

    it('allows audio clip managers', () => {
      const asset = { mediaType: MediaAssetType.AUDIO, audioClip: {} };
      expect(canManageMediaAsset(asset, [P.instant.manage])).toBe(true);
      expect(canManageMediaAsset(asset, [P.song.manage])).toBe(false);
    });

    it('allows background audio managers', () => {
      const asset = { mediaType: MediaAssetType.AUDIO, backgroundAudio: {} };
      expect(canManageMediaAsset(asset, [P.scene.manage])).toBe(true);
      expect(canManageMediaAsset(asset, [P.instant.manage])).toBe(false);
    });

    it('allows song managers', () => {
      const asset = { mediaType: MediaAssetType.AUDIO, song: {} };
      expect(canManageMediaAsset(asset, [P.song.manage])).toBe(true);
      expect(canManageMediaAsset(asset, [P.instant.manage])).toBe(false);
    });

    it('allows transition managers', () => {
      const asset = { mediaType: MediaAssetType.VIDEO, transition: {} };
      expect(canManageMediaAsset(asset, [P.stinger.manage])).toBe(true);
      expect(canManageMediaAsset(asset, [P.song.manage])).toBe(false);
    });

    it('denies an asset with no capability', () => {
      expect(
        canManageMediaAsset({ mediaType: MediaAssetType.AUDIO }, [
          P.instant.manage,
          P.song.manage,
          P.stinger.manage,
          P.scene.manage,
        ]),
      ).toBe(false);
    });
  });

  describe('assertions', () => {
    it('assertCanManageMediaAsset throws a coded ForbiddenException', () => {
      expect.assertions(3);
      try {
        assertCanManageMediaAsset({ mediaType: MediaAssetType.IMAGE }, []);
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getResponse()).toEqual({
          error: 'MEDIA_ASSET_MANAGE_FORBIDDEN',
        });
      }
      expect(() =>
        assertCanManageMediaAsset({ mediaType: MediaAssetType.IMAGE }, [
          P.media.manage,
        ]),
      ).not.toThrow();
    });

    it('assertCanManageLabels accepts wildcard and each manage permission', () => {
      expect(() => assertCanManageLabels(['*'])).not.toThrow();
      for (const permission of [
        P.media.manage,
        P.instant.manage,
        P.song.manage,
        P.stinger.manage,
        P.scene.manage,
      ]) {
        expect(() => assertCanManageLabels([permission])).not.toThrow();
      }
      try {
        assertCanManageLabels([]);
        throw new Error('expected throw');
      } catch (error) {
        expect((error as ForbiddenException).getResponse()).toEqual({
          error: 'MEDIA_LABEL_MANAGE_FORBIDDEN',
        });
      }
    });

    it('assertCanManageBackgroundAudio accepts wildcard and scene manage', () => {
      expect(() => assertCanManageBackgroundAudio(['*'])).not.toThrow();
      expect(() =>
        assertCanManageBackgroundAudio([P.scene.manage]),
      ).not.toThrow();
      try {
        assertCanManageBackgroundAudio([]);
        throw new Error('expected throw');
      } catch (error) {
        expect((error as ForbiddenException).getResponse()).toEqual({
          error: 'BACKGROUND_AUDIO_MANAGE_FORBIDDEN',
        });
      }
    });
  });
});
