import { Module, Global } from '@nestjs/common';
import { RadioController } from './radio.controller';
import { RadioService } from './radio.service';
import { SongExecutionEngine } from './song-execution.engine';
import { NowPlayingPublisherService } from './now-playing-publisher.service';
import { PrismaService } from '../prisma.service';

@Global()
@Module({
  controllers: [RadioController],
  providers: [
    RadioService,
    SongExecutionEngine,
    NowPlayingPublisherService,
    PrismaService,
  ],
  exports: [RadioService, SongExecutionEngine, NowPlayingPublisherService],
})
export class RadioModule {}
