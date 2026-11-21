import { Controller, Get } from '@nestjs/common';
import { ChartFeedEntry, ChartsService } from './charts.service';
import { Public } from '../auth/public.decorator';

@Controller('charts')
@Public()
export class ChartsController {
  constructor(private readonly chartsService: ChartsService) {}

  /** Provider-neutral chart feed; public, for the program page in the renderer. */
  @Get('realtime')
  async getRealtimeFeed(): Promise<ChartFeedEntry[]> {
    return this.chartsService.getRealtimeFeed();
  }
}
