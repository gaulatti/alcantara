import { OperatorChangeModule } from '../operator-change/operator-change.module';
import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SongsController } from './songs.controller';
import { SongReanalysisController } from './song-reanalysis.controller';
import { SongReanalysisService } from './song-reanalysis.service';
import { SongsService } from './songs.service';
import { SongsMcpTools } from '../mcp/capabilities/songs';
import { SongReanalysisMcpTools } from '../mcp/capabilities/song-reanalysis';

@Module({
  imports: [OperatorChangeModule],
  controllers: [SongsController, SongReanalysisController],
  providers: [
    SongsService,
    SongReanalysisService,
    SongsMcpTools,
    SongReanalysisMcpTools,
    PrismaService,
  ],
  exports: [SongsService],
})
export class SongsModule {}
