import { Controller, Get } from '@nestjs/common';
import { CachedChartsResponse, ChartsService } from './charts.service';

@Controller('charts')
export class ChartsController {
  constructor(private readonly chartsService: ChartsService) {}

  @Get('sanremo-realtime')
  async getSanremoRealtime(): Promise<CachedChartsResponse> {
    return this.chartsService.getSanremoRealtime();
  }
}
