import { Controller, Get } from '@nestjs/common';
import {
  CachedChartsResponse,
  ChartFeedEntry,
  ChartsService,
} from './charts.service';
import { Public } from '../auth/public.decorator';

@Controller('charts')
@Public()
export class ChartsController {
  constructor(private readonly chartsService: ChartsService) {}

  @Get('sanremo-realtime')
  async getSanremoRealtime(): Promise<CachedChartsResponse> {
    return this.chartsService.getSanremoRealtime();
  }

  /** Provider-neutral chart feed; public like the proxy, for the program page. */
  @Get('realtime')
  async getRealtimeFeed(): Promise<ChartFeedEntry[]> {
    return this.chartsService.getRealtimeFeed();
  }
}
