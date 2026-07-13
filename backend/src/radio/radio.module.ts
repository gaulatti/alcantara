import { Module, Global } from '@nestjs/common';
import { RadioController } from './radio.controller';
import { RadioService } from './radio.service';
import { SongExecutionEngine } from './song-execution.engine';
import { PrismaService } from '../prisma.service';

@Global()
@Module({
  controllers: [RadioController],
  providers: [RadioService, SongExecutionEngine, PrismaService],
  exports: [RadioService, SongExecutionEngine],
})
export class RadioModule {}
