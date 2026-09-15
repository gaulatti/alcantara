import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { MediaAssetKind, Prisma } from '@prisma/client';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import {
  syncAudioClipAsset,
  syncImageAsset,
  syncSongAsset,
  syncTransitionAsset,
} from './media-asset-sync';
import {
  legacyMediaGroupLabelId,
  syncLegacyMediaGroupLabel,
} from './media-label-sync';

export interface MediaAssetReconciliationResult {
  images: number;
  audioClips: number;
  songs: number;
  transitions: number;
  backgroundAudio: number;
  labels: number;
  removedOrphans: number;
}

function parseBackgroundInstantId(metadata: string | null): number | null {
  if (!metadata?.trim()) return null;
  try {
    const parsed = JSON.parse(metadata) as {
      sceneInstant?: { instantId?: unknown };
    };
    const value = Number(parsed.sceneInstant?.instantId);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

@Injectable()
export class MediaAssetsReconciliationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MediaAssetsReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: ManagedMetricsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const result = await this.reconcile();
      this.metrics.recordJob('media-asset-reconciliation', 'success');
      this.logger.log(
        `Media assets reconciled: ${result.images} images, ${result.audioClips} instant-capable audio assets, ${result.backgroundAudio} background-capable audio assets, ${result.songs} song-capable audio assets, ${result.transitions} transition-capable videos, ${result.labels} labels, ${result.removedOrphans} orphaned registry rows removed`,
      );
    } catch (error) {
      this.metrics.recordJob('media-asset-reconciliation', 'failure');
      this.logger.error('Media asset reconciliation failed');
      throw error;
    }
  }

  async reconcile(): Promise<MediaAssetReconciliationResult> {
    return this.prisma.$transaction(async (tx) => {
      const [images, audioClips, songs, transitions, scenes] =
        await Promise.all([
          tx.media.findMany(),
          tx.instant.findMany(),
          tx.song.findMany(),
          tx.stinger.findMany(),
          tx.scene.findMany({ select: { metadata: true } }),
        ]);

      for (const image of images) await syncImageAsset(tx, image);
      const audioAssetIds = new Map<number, string>();
      for (const audioClip of audioClips) {
        audioAssetIds.set(
          audioClip.id,
          await syncAudioClipAsset(tx, audioClip),
        );
      }
      for (const song of songs) await syncSongAsset(tx, song);
      for (const transition of transitions)
        await syncTransitionAsset(tx, transition);

      const backgroundInstantIds = new Set(
        scenes
          .map((scene) => parseBackgroundInstantId(scene.metadata))
          .filter((id): id is number => id !== null),
      );
      let backgroundAudio = 0;
      for (const instantId of backgroundInstantIds) {
        const assetId = audioAssetIds.get(instantId);
        const instant = audioClips.find(
          (candidate) => candidate.id === instantId,
        );
        if (!assetId || !instant) continue;
        await tx.backgroundAudioCapability.upsert({
          where: { assetId },
          create: { assetId, defaultVolume: instant.volume },
          update: { defaultVolume: instant.volume },
        });
        backgroundAudio += 1;
      }

      const mediaGroups = await tx.mediaGroup.findMany({
        include: {
          mediaItems: {
            include: { media: true },
            orderBy: { position: 'asc' },
          },
        },
      });
      for (const group of mediaGroups) {
        await syncLegacyMediaGroupLabel(tx, group);
      }

      const removedOrphans = await this.removeOrphans(tx);
      return {
        images: images.length,
        audioClips: audioClips.length,
        songs: songs.length,
        transitions: transitions.length,
        backgroundAudio,
        labels: mediaGroups.length,
        removedOrphans,
      };
    });
  }

  private async removeOrphans(tx: Prisma.TransactionClient): Promise<number> {
    const legacyGroupIds = await tx.mediaGroup.findMany({
      select: { id: true },
    });
    const expectedLegacyLabelIds = legacyGroupIds.map((group) =>
      legacyMediaGroupLabelId(group.id),
    );
    const results = await Promise.all([
      tx.mediaAsset.deleteMany({
        where: { kind: MediaAssetKind.IMAGE, image: { is: null } },
      }),
      tx.mediaAsset.deleteMany({
        where: {
          kind: MediaAssetKind.AUDIO_CLIP,
          audioClip: { is: null },
        },
      }),
      tx.mediaAsset.deleteMany({
        where: { kind: MediaAssetKind.SONG, song: { is: null } },
      }),
      tx.mediaAsset.deleteMany({
        where: {
          kind: MediaAssetKind.TRANSITION,
          transition: { is: null },
        },
      }),
      tx.mediaAsset.deleteMany({
        where: {
          id: { startsWith: 'song-cover:' },
          songCovers: { none: {} },
        },
      }),
      tx.mediaLabel.deleteMany({
        where: {
          id: {
            startsWith: 'legacy-media-group:',
            notIn: expectedLegacyLabelIds,
          },
        },
      }),
    ]);
    return results.reduce((total, result) => total + result.count, 0);
  }
}
