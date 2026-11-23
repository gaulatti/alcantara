import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ArtistLabelsMcpTools } from '../mcp/capabilities/artist-labels';
import { ArtistLabelsController } from './artist-labels.controller';
import { ArtistLabelsService } from './artist-labels.service';

@Module({
  controllers: [ArtistLabelsController],
  providers: [ArtistLabelsMcpTools, ArtistLabelsService, PrismaService],
  exports: [ArtistLabelsService],
})
export class ArtistLabelsModule {}
