import { Controller, Get, Header } from '@nestjs/common';
import { RadioMetricsService } from './radio/radio-metrics.service';
import { Public } from './auth/public.decorator';

/**
 * Exposes bounded-cardinality Prometheus telemetry for the Alcantara radio
 * engine. Intended for the private scrape boundary, matching the Palazzo
 * deployment convention.
 */
@Controller()
@Public()
export class MetricsController {
  constructor(private readonly radioMetrics: RadioMetricsService) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  getMetrics(): string {
    return this.radioMetrics.render();
  }
}
