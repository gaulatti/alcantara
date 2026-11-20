import { Controller, Get, Header, Res, UseGuards } from '@nestjs/common';
import { RadioMetricsService } from './radio/radio-metrics.service';
import { Public } from './auth/public.decorator';
import { ManagedMetricsService } from './observability/managed-metrics.service';
import { PalazzoMetricsPassthrough } from './observability/palazzo-metrics.passthrough';
import { MetricsTokenGuard } from './observability/metrics-token.guard';

export const PALAZZO_METRICS_CONTENT_TYPE =
  'text/plain; version=0.0.4; charset=utf-8';

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
    private readonly palazzoMetrics: PalazzoMetricsPassthrough,
  ) {}

  @Get('metrics')
  @UseGuards(MetricsTokenGuard)
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async getMetrics(): Promise<string> {
    return this.managedMetrics.render(this.radioMetrics.render());
  }

  /**
   * Serves Palazzo's `/metrics` text through Alcantara's one authenticated
   * scrape boundary. Any failure answers 502 with an empty body.
   */
  @Get('metrics/palazzo')
  @UseGuards(MetricsTokenGuard)
  async getPalazzoMetrics(
    @Res({ passthrough: true })
    response: {
      status(code: number): unknown;
      setHeader(name: string, value: string): unknown;
    },
  ): Promise<string> {
    const body = await this.palazzoMetrics.fetch();
    if (body === null) {
      response.status(502);
      return '';
    }
    response.setHeader('Content-Type', PALAZZO_METRICS_CONTENT_TYPE);
    return body;
  }
}
