import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';
import {
  OperatorPreferencesService,
  type OperatorAuthorization,
} from './operator-preferences.service';

type AuthorizedRequest = {
  user: { sub: string; authorization: OperatorAuthorization };
};

@Controller('operator-preferences')
@RequirePermission(ALCANTARA_PERMISSIONS.access)
export class OperatorPreferencesController {
  constructor(private readonly preferences: OperatorPreferencesService) {}

  @Get('shared')
  discover(
    @Query('scope') scope: string,
    @Query('scopeId') scopeId: string,
    @Req() request: AuthorizedRequest,
  ) {
    return this.preferences.discover(
      scope,
      scopeId,
      request.user.authorization,
    );
  }

  @Post('shared')
  @RequirePermission(ALCANTARA_PERMISSIONS.layout.manage)
  publish(
    @Body() body: Record<string, unknown>,
    @Req() request: AuthorizedRequest,
  ) {
    return this.preferences.publish(
      request.user.sub,
      body,
      request.user.authorization,
    );
  }

  @Post('shared/:id/load')
  load(
    @Param('id') id: string,
    @Body() body: { deviceClass?: unknown; version?: unknown },
    @Req() request: AuthorizedRequest,
  ) {
    return this.preferences.load(
      request.user.sub,
      id,
      body,
      request.user.authorization,
    );
  }

  @Delete('shared/:id')
  @RequirePermission(ALCANTARA_PERMISSIONS.layout.manage)
  retire(@Param('id') id: string, @Req() request: AuthorizedRequest) {
    return this.preferences.retire(id, request.user.authorization);
  }

  @Get(':deviceClass')
  get(
    @Param('deviceClass') deviceClass: string,
    @Req() request: AuthorizedRequest,
  ) {
    return this.preferences.get(request.user.sub, deviceClass);
  }

  @Put(':deviceClass')
  save(
    @Param('deviceClass') deviceClass: string,
    @Body() body: { version?: unknown; profile?: unknown },
    @Req() request: AuthorizedRequest,
  ) {
    return this.preferences.save(request.user.sub, deviceClass, body);
  }

  @Delete(':deviceClass')
  resetClass(
    @Param('deviceClass') deviceClass: string,
    @Req() request: AuthorizedRequest,
  ) {
    return this.preferences.reset(request.user.sub, deviceClass);
  }

  @Delete()
  resetAll(@Req() request: AuthorizedRequest) {
    return this.preferences.reset(request.user.sub);
  }
}
