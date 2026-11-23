import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SongsController } from './songs.controller';
import { SongsService } from './songs.service';
import { SongsMcpTools } from '../mcp/capabilities/songs';

@Module({
  controllers: [SongsController],
  providers: [SongsService, SongsMcpTools, PrismaService],
  exports: [SongsService],
})
export class SongsModule {}
