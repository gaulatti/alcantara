import { Global, Module } from '@nestjs/common';
import { HttpMetricsHook } from './http-metrics.hook';
import { ManagedMetricsService } from './managed-metrics.service';
import { PalazzoMetricsPassthrough } from './palazzo-metrics.passthrough';
import { MetricsTokenGuard } from './metrics-token.guard';

@Global()
@Module({
  providers: [
    ManagedMetricsService,
    MetricsTokenGuard,
    PalazzoMetricsPassthrough,
    HttpMetricsHook,
  ],
  exports: [
    ManagedMetricsService,
    MetricsTokenGuard,
    PalazzoMetricsPassthrough,
  ],
})
export class ObservabilityModule {}
