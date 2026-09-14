import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { MediaAssetsReconciliationService } from './media-assets-reconciliation.service';

@Module({
  providers: [MediaAssetsReconciliationService, PrismaService],
})
export class MediaAssetsModule {}
