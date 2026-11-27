import { Global, Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PlayoutLease } from './playout-lease.service';

/** The playout lease and the readiness endpoint (alcantara#873). Global: every writer and scheduler asks it. */
@Global()
@Module({
  controllers: [HealthController],
  providers: [PlayoutLease],
  exports: [PlayoutLease],
})
export class PlayoutModule {}
