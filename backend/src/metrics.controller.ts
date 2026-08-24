import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { RadioMetricsService } from './radio/radio-metrics.service';
import { Public } from './auth/public.decorator';
import { ManagedMetricsService } from './observability/managed-metrics.service';
import { MetricsTokenGuard } from './observability/metrics-token.guard';

/**
 * Exposes bounded-cardinality Prometheus telemetry for the Alcantara radio
 * engine. Intended for the private scrape boundary, matching the Palazzo
 * deployment convention.
 */
@Controller()
@Public()
export class MetricsController {
  constructor(
    private readonly radioMetrics: RadioMetricsService,
    private readonly managedMetrics: ManagedMetricsService,
  ) {}

  @Get('metrics')
  @UseGuards(MetricsTokenGuard)
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async getMetrics(): Promise<string> {
    return this.managedMetrics.render(this.radioMetrics.render());
  }
}
