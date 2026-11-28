import { Body, Controller, Delete, Get, Param, Put, Req } from '@nestjs/common';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { FillerService } from './filler.service';

type AuthorizedRequest = { user: { sub: string } };

/** Per-program filler configuration (gaulatti/alcantara#126). */
@Controller('broadcast/programs/:programId/fillers')
export class FillerController {
  constructor(private readonly fillers: FillerService) {}

  @Get()
  @RequirePermission(ALCANTARA_PERMISSIONS.broadcast.view)
  getState(@Param('programId') programId: string) {
    return this.fillers.getState(programId);
  }

  @Put('television')
  @RequirePermission(ALCANTARA_PERMISSIONS.broadcast.manage)
  prepareTelevision(
    @Param('programId') programId: string,
    @Body() body: { assetId?: unknown },
    @Req() request: AuthorizedRequest,
  ) {
    return this.fillers.prepareTelevision(programId, body, request.user.sub);
  }

  @Put('radio')
  @RequirePermission(ALCANTARA_PERMISSIONS.broadcast.manage)
  prepareRadio(
    @Param('programId') programId: string,
    @Body() body: { assetIds?: unknown; mode?: unknown; shuffleSeed?: unknown },
    @Req() request: AuthorizedRequest,
  ) {
    return this.fillers.prepareRadio(programId, body, request.user.sub);
  }

  @Delete('radio')
  @RequirePermission(ALCANTARA_PERMISSIONS.broadcast.manage)
  removeRadio(@Param('programId') programId: string) {
    return this.fillers.removeRadio(programId);
  }
}
