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

export interface MediaAssetReconciliationResult {
  images: number;
  audioClips: number;
  songs: number;
  transitions: number;
  removedOrphans: number;
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
        `Media assets reconciled: ${result.images} images, ${result.audioClips} audio clips, ${result.songs} songs, ${result.transitions} transitions, ${result.removedOrphans} orphaned registry rows removed`,
      );
    } catch (error) {
      this.metrics.recordJob('media-asset-reconciliation', 'failure');
      this.logger.error('Media asset reconciliation failed');
      throw error;
    }
  }

  async reconcile(): Promise<MediaAssetReconciliationResult> {
    return this.prisma.$transaction(async (tx) => {
      const [images, audioClips, songs, transitions] = await Promise.all([
        tx.media.findMany(),
        tx.instant.findMany(),
        tx.song.findMany(),
        tx.stinger.findMany(),
      ]);

      for (const image of images) await syncImageAsset(tx, image);
      for (const audioClip of audioClips)
        await syncAudioClipAsset(tx, audioClip);
      for (const song of songs) await syncSongAsset(tx, song);
      for (const transition of transitions)
        await syncTransitionAsset(tx, transition);

      const removedOrphans = await this.removeOrphans(tx);
      return {
        images: images.length,
        audioClips: audioClips.length,
        songs: songs.length,
        transitions: transitions.length,
        removedOrphans,
      };
    });
  }

  private async removeOrphans(tx: Prisma.TransactionClient): Promise<number> {
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
    ]);
    return results.reduce((total, result) => total + result.count, 0);
  }
}
