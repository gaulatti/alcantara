import { Module, Global } from '@nestjs/common';
import { RadioController } from './radio.controller';
import { RadioService } from './radio.service';
import { SongExecutionEngine } from './song-execution.engine';
import { NowPlayingPublisherService } from './now-playing-publisher.service';
import { PalazzoRadioTelemetryService } from './palazzo-telemetry.service';
import { RadioMetricsService } from './radio-metrics.service';
import { PalazzoMachineClient } from './palazzo-machine.client';
import { PrismaService } from '../prisma.service';

@Global()
@Module({
  controllers: [RadioController],
  providers: [
    RadioService,
    SongExecutionEngine,
    NowPlayingPublisherService,
    PalazzoRadioTelemetryService,
    RadioMetricsService,
    PalazzoMachineClient,
    PrismaService,
  ],
  exports: [
    RadioService,
    SongExecutionEngine,
    NowPlayingPublisherService,
    PalazzoRadioTelemetryService,
    RadioMetricsService,
    PalazzoMachineClient,
  ],
})
export class RadioModule {}
