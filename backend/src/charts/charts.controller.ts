import { Controller, Get } from '@nestjs/common';
import { CachedChartsResponse, ChartsService } from './charts.service';
import { Public } from '../auth/public.decorator';

@Controller('charts')
@Public()
export class ChartsController {
  constructor(private readonly chartsService: ChartsService) {}

  @Get('sanremo-realtime')
  async getSanremoRealtime(): Promise<CachedChartsResponse> {
    return this.chartsService.getSanremoRealtime();
  }
}
