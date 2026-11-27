import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { PlayoutLease } from './playout-lease.service';

/**
 * Readiness for the deploy's handover (alcantara#873): a standby is loaded and listening but does not drive playout;
 * the active instance does. Never held by the standby gate.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly lease: PlayoutLease) {}

  @Get('ready')
  @Public()
  @Header('Cache-Control', 'no-store')
  ready() {
    return {
      state: this.lease.current,
      build: process.env.ALCANTARA_BUILD_VERSION ?? null,
    };
  }
}
