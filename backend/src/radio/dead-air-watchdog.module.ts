import { Module } from '@nestjs/common';
import { WebrtcModule } from '../webrtc/webrtc.module';
import { DeadAirWatchdogService } from './dead-air-watchdog.service';

/**
 * The dead-air watchdog in its own module: it reads who is on air through calls (WebrtcModule), and the calls module
 * already reads the radio (RadioModule is global), so it cannot live in RadioModule without a cycle.
 */
@Module({
  imports: [WebrtcModule],
  providers: [DeadAirWatchdogService],
})
export class DeadAirWatchdogModule {}
