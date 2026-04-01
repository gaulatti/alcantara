import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

@Module({
  controllers: [MediaController],
  providers: [MediaService, PrismaService],
  exports: [MediaService],
})
export class MediaModule {}
