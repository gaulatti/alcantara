import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { BroadcastDestinationsService } from './broadcast-destinations.service';
import { BroadcastIngestService } from './broadcast-ingest.service';

type AuthorizedRequest = { user: { sub: string } };
type TeamRequest = {
  user: { sub: string; authorization: { teamId: number } };
};

@Controller('broadcast')
export class BroadcastDestinationsController {
  constructor(
    private readonly service: BroadcastDestinationsService,
    private readonly ingest: BroadcastIngestService,
  ) {}

  @Get('destinations')
  @RequirePermission(ALCANTARA_PERMISSIONS.broadcast.view)
  listDestinations(@Req() request: TeamRequest) {
    return this.service.listDestinations(request.user.authorization.teamId);
  }

  @Get('destinations/catalog')
  @RequirePermission(ALCANTARA_PERMISSIONS.broadcast.manage)
  listCatalog() {
    return this.service.listCatalog();
  }

  @Post('destinations')
  @RequirePermission(ALCANTARA_PERMISSIONS.broadcast.manage)
  createDestination(
    @Body() body: Record<string, unknown>,
    @Req() request: TeamRequest,
  ) {
    return this.service.createDestination(
      body,
      request.user.authorization.teamId,
    );
  }

  /**
   * The ingest address and key of one destination, for the desktop studio at Go live
   * (gaulatti/carmencita#4). A credential: manage permission only, audited on every call,
   * never cached, and not an MCP capability.
   */
  @Post('destinations/:destinationId/ingest')
  @RequirePermission(ALCANTARA_PERMISSIONS.broadcast.manage)
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  issueIngest(
    @Param('destinationId') destinationId: string,
    @Req() request: TeamRequest,
  ) {
    return this.ingest.issue(
      destinationId,
      request.user.sub,
      request.user.authorization.teamId,
    );
  }

  @Put('destinations/order')
  @RequirePermission(ALCANTARA_PERMISSIONS.broadcast.manage)
  reorderDestinations(@Body() body: { destinationIds?: unknown }) {
    return this.service.reorderDestinations(body.destinationIds);
  }

  @Put('destinations/:destinationId')
  @RequirePermission(ALCANTARA_PERMISSIONS.broadcast.manage)
  updateDestination(
    @Param('destinationId') destinationId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.service.updateDestination(destinationId, body);
  }

  @Post('destinations/:destinationId/retire')
  @RequirePermission(ALCANTARA_PERMISSIONS.broadcast.manage)
  retireDestination(@Param('destinationId') destinationId: string) {
    return this.service.setRetired(destinationId, true);
  }

  @Post('destinations/:destinationId/restore')
  @RequirePermission(ALCANTARA_PERMISSIONS.broadcast.manage)
  restoreDestination(@Param('destinationId') destinationId: string) {
    return this.service.setRetired(destinationId, false);
  }

  @Get('programs/:programId')
  @RequirePermission(ALCANTARA_PERMISSIONS.broadcast.view)
  getProgramState(@Param('programId') programId: string) {
    return this.service.getProgramState(programId);
  }

  @Post('programs/:programId/reload')
  @RequirePermission(ALCANTARA_PERMISSIONS.broadcast.operate)
  reload(
    @Param('programId') programId: string,
    @Body() body: Record<string, unknown>,
    @Req() request: AuthorizedRequest,
  ) {
    return this.service.reload(programId, body, request.user.sub);
  }

  @Post('programs/:programId/start')
  @RequirePermission(ALCANTARA_PERMISSIONS.broadcast.operate)
  start(
    @Param('programId') programId: string,
    @Body() body: Record<string, unknown>,
    @Req() request: AuthorizedRequest,
  ) {
    return this.service.start(programId, body, request.user.sub);
  }

  @Post('programs/:programId/stop')
  @RequirePermission(ALCANTARA_PERMISSIONS.broadcast.operate)
  stop(
    @Param('programId') programId: string,
    @Body() body: Record<string, unknown>,
    @Req() request: AuthorizedRequest,
  ) {
    return this.service.stop(programId, body, request.user.sub);
  }
}
