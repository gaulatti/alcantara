import { ObservabilityModule } from './observability.module';
import { HttpMetricsHook } from './http-metrics.hook';
import { ManagedMetricsService } from './managed-metrics.service';
import { PalazzoMetricsPassthrough } from './palazzo-metrics.passthrough';
import { MetricsTokenGuard } from './metrics-token.guard';

describe('ObservabilityModule wiring', () => {
  it('is global and provides the metrics service, scrape guard, and the HTTP metrics hook', () => {
    expect(Reflect.getMetadata('__module:global__', ObservabilityModule)).toBe(
      true,
    );
    expect(Reflect.getMetadata('providers', ObservabilityModule)).toEqual([
      ManagedMetricsService,
      MetricsTokenGuard,
      PalazzoMetricsPassthrough,
      HttpMetricsHook,
    ]);
    expect(Reflect.getMetadata('exports', ObservabilityModule)).toEqual([
      ManagedMetricsService,
      MetricsTokenGuard,
      PalazzoMetricsPassthrough,
    ]);
  });
});
