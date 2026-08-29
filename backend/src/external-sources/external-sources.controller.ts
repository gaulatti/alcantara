import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';
import {
  ExternalSourcesService,
  type SourceAuthorization,
} from './external-sources.service';
import { ExternalSourceMetricsInterceptor } from './external-source-metrics.interceptor';

type AuthorizedRequest = {
  user: { sub: string; authorization: SourceAuthorization };
};

@Controller('external-sources')
@RequirePermission(ALCANTARA_PERMISSIONS.webrtc.read)
@UseInterceptors(ExternalSourceMetricsInterceptor)
export class ExternalSourcesController {
  constructor(private readonly sources: ExternalSourcesService) {}

  @Get()
  list(@Req() request: AuthorizedRequest) {
    return this.sources.list(request.user.authorization);
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() request: AuthorizedRequest) {
    return this.sources.get(id, request.user.authorization);
  }

  @Post()
  @RequirePermission(ALCANTARA_PERMISSIONS.webrtc.operate)
  create(
    @Body() body: Record<string, unknown>,
    @Req() request: AuthorizedRequest,
  ) {
    return this.sources.create(
      request.user.sub,
      body,
      request.user.authorization,
    );
  }

  @Patch(':id')
  @RequirePermission(ALCANTARA_PERMISSIONS.webrtc.operate)
  update(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Req() request: AuthorizedRequest,
  ) {
    return this.sources.update(id, body, request.user.authorization);
  }

  @Post(':id/credentials/rotate')
  @RequirePermission(ALCANTARA_PERMISSIONS.webrtc.operate)
  rotate(@Param('id') id: string, @Req() request: AuthorizedRequest) {
    return this.sources.rotateCredential(id, request.user.authorization);
  }

  @Post(':id/redirects/validate')
  @RequirePermission(ALCANTARA_PERMISSIONS.webrtc.operate)
  redirect(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Req() request: AuthorizedRequest,
  ) {
    return this.sources.validateRedirect(
      id,
      body.url,
      request.user.authorization,
    );
  }

  @Post(':id/reconcile')
  @RequirePermission(ALCANTARA_PERMISSIONS.webrtc.operate)
  reconcile(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Req() request: AuthorizedRequest,
  ) {
    return this.sources.reconcile(id, body, request.user.authorization);
  }

  @Delete(':id')
  @RequirePermission(ALCANTARA_PERMISSIONS.webrtc.operate)
  revoke(@Param('id') id: string, @Req() request: AuthorizedRequest) {
    return this.sources.revoke(id, request.user.authorization);
  }
}
