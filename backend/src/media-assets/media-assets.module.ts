import { OperatorChangeModule } from '../operator-change/operator-change.module';
import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { MediaAssetsController } from './media-assets.controller';
import { MediaAssetsReconciliationService } from './media-assets-reconciliation.service';
import { MediaAssetsService } from './media-assets.service';
import { MediaAssetsMcpTools } from '../mcp/capabilities/media-assets';

@Module({
  imports: [OperatorChangeModule],
  controllers: [MediaAssetsController],
  providers: [
    MediaAssetsReconciliationService,
    MediaAssetsService,
    MediaAssetsMcpTools,
    PrismaService,
  ],
})
export class MediaAssetsModule {}
