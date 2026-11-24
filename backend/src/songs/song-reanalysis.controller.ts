import { Body, Controller, Post } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';
import { SongReanalysisService } from './song-reanalysis.service';

/** gaulatti/alcantara#235: queues songs for a new analysis (at most 25), keeping their cues until it finishes. */
@Controller('songs')
export class SongReanalysisController {
  constructor(private readonly reanalysis: SongReanalysisService) {}

  @Post('reanalysis')
  @RequirePermission(ALCANTARA_PERMISSIONS.song.manage)
  async requestReanalysis(@Body() body: { songIds?: unknown }) {
    return this.reanalysis.request(body?.songIds);
  }
}
