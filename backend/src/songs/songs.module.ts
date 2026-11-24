import { OperatorChangeModule } from '../operator-change/operator-change.module';
import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SongsController } from './songs.controller';
import { SongsService } from './songs.service';
import { SongsMcpTools } from '../mcp/capabilities/songs';
import { SongReanalysisMcpTools } from '../mcp/capabilities/song-reanalysis';

@Module({
  imports: [OperatorChangeModule],
  controllers: [SongsController],
  providers: [
    SongsService,
    SongsMcpTools,
    SongReanalysisMcpTools,
    PrismaService,
  ],
  exports: [SongsService],
})
export class SongsModule {}
