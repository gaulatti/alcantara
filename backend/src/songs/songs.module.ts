import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SongsController } from './songs.controller';
import { SongsService } from './songs.service';

@Module({
  controllers: [SongsController],
  providers: [SongsService, PrismaService],
})
export class SongsModule {}
