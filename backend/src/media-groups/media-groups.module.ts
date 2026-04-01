import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { MediaGroupsController } from './media-groups.controller';
import { MediaGroupsService } from './media-groups.service';

@Module({
  controllers: [MediaGroupsController],
  providers: [MediaGroupsService, PrismaService],
})
export class MediaGroupsModule {}
