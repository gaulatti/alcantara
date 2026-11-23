import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ArtistLabelsService } from './artist-labels.service';

type TeamRequest = { user: { authorization: { teamId: number } } };

/** Contract C4 of gaulatti/alcantara#222: the media label attached to an artist. */
@Controller('artist-labels')
export class ArtistLabelsController {
  constructor(private readonly artistLabels: ArtistLabelsService) {}

  @Get()
  @RequirePermission(ALCANTARA_PERMISSIONS.media.read)
  list(@Req() request: TeamRequest) {
    return this.artistLabels.list(request.user.authorization.teamId);
  }

  @Put()
  @RequirePermission(ALCANTARA_PERMISSIONS.media.manage)
  set(
    @Body() body: { artist?: unknown; labelId?: unknown },
    @Req() request: TeamRequest,
  ) {
    return this.artistLabels.set(
      request.user.authorization.teamId,
      body?.artist,
      body?.labelId,
    );
  }
}
