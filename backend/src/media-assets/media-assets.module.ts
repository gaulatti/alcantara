import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { MediaAssetsController } from './media-assets.controller';
import { MediaAssetsReconciliationService } from './media-assets-reconciliation.service';
import { MediaAssetsService } from './media-assets.service';

@Module({
  controllers: [MediaAssetsController],
  providers: [
    MediaAssetsReconciliationService,
    MediaAssetsService,
    PrismaService,
  ],
})
export class MediaAssetsModule {}
