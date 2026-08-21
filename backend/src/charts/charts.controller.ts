import { Controller, Get } from '@nestjs/common';
import { CachedChartsResponse, ChartsService } from './charts.service';
import { RendererPublic } from '../auth/renderer-boundary';

@Controller('charts')
export class ChartsController {
  constructor(private readonly chartsService: ChartsService) {}

  @Get('sanremo-realtime')
  @RendererPublic('sanremo-realtime-read')
  async getSanremoRealtime(): Promise<CachedChartsResponse> {
    return this.chartsService.getSanremoRealtime();
  }
}
