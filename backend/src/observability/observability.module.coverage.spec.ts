import { APP_INTERCEPTOR } from '@nestjs/core';
import { ObservabilityModule } from './observability.module';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { ManagedMetricsService } from './managed-metrics.service';
import { MetricsTokenGuard } from './metrics-token.guard';

describe('ObservabilityModule wiring', () => {
  it('is global and provides the metrics service, scrape guard, and http interceptor', () => {
    expect(Reflect.getMetadata('__module:global__', ObservabilityModule)).toBe(
      true,
    );
    expect(Reflect.getMetadata('providers', ObservabilityModule)).toEqual([
      ManagedMetricsService,
      MetricsTokenGuard,
      { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
    ]);
    expect(Reflect.getMetadata('exports', ObservabilityModule)).toEqual([
      ManagedMetricsService,
      MetricsTokenGuard,
    ]);
  });
});
