import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { ManagedMetricsService } from './managed-metrics.service';
import { MetricsTokenGuard } from './metrics-token.guard';

@Global()
@Module({
  providers: [
    ManagedMetricsService,
    MetricsTokenGuard,
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
  exports: [ManagedMetricsService, MetricsTokenGuard],
})
export class ObservabilityModule {}
