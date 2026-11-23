import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { MediaGroupsController } from './media-groups.controller';
import { MediaGroupsService } from './media-groups.service';
import { MediaGroupsMcpTools } from '../mcp/capabilities/media-groups';

@Module({
  controllers: [MediaGroupsController],
  providers: [MediaGroupsService, MediaGroupsMcpTools, PrismaService],
})
export class MediaGroupsModule {}
