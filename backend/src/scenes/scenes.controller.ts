import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Put,
  Delete,
  Req,
} from '@nestjs/common';
import { ScenesService } from './scenes.service';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';
import { callerTeam, type TeamRequest } from '../tenancy/caller-team';

@Controller('scenes')
@RequirePermission(ALCANTARA_PERMISSIONS.scene.read)
export class ScenesController {
  constructor(private readonly scenesService: ScenesService) {}

  @Get()
  async findAll(@Req() request: TeamRequest) {
    return this.scenesService.findAll(callerTeam(request));
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Req() request: TeamRequest) {
    return this.scenesService.findOne(+id, callerTeam(request));
  }

  @Post()
  @RequirePermission(ALCANTARA_PERMISSIONS.scene.manage)
  async create(
    @Body()
    data: {
      name: string;
      layoutId: number;
      chyronText?: string;
      metadata?: any;
      externalSourceId?: string;
    },
    @Req() request: TeamRequest,
  ) {
    return this.scenesService.create(data, callerTeam(request));
  }

  @Put(':id')
  @RequirePermission(ALCANTARA_PERMISSIONS.scene.manage)
  async update(
    @Param('id') id: string,
    @Body()
    data: {
      name?: string;
      layoutId?: number;
      chyronText?: string;
      metadata?: any;
      externalSourceId?: string | null;
    },
    @Req() request: TeamRequest,
  ) {
    return this.scenesService.update(+id, data, callerTeam(request));
  }

  @Put(':id/chyron')
  @RequirePermission(ALCANTARA_PERMISSIONS.scene.operate)
  async updateChyron(
    @Param('id') id: string,
    @Body() data: { chyronText: string },
    @Req() request: TeamRequest,
  ) {
    return this.scenesService.updateChyron(
      +id,
      data.chyronText,
      callerTeam(request),
    );
  }

  // The generic path is the contract; the earlier branded path answers the same until every caller has moved.
  @Post([':id/bracket/draw', ':id/modo-italiano-bracket/draw'])
  @RequirePermission(ALCANTARA_PERMISSIONS.scene.operate)
  async drawBracket(
    @Param('id') id: string,
    @Body() data: { componentType?: string; seed?: number },
    @Req() request: TeamRequest,
  ) {
    return this.scenesService.drawBracket(+id, data, callerTeam(request));
  }

  @Post([':id/bracket/vote', ':id/modo-italiano-bracket/vote'])
  @RequirePermission(ALCANTARA_PERMISSIONS.scene.operate)
  async voteBracket(
    @Param('id') id: string,
    @Body()
    data: {
      componentType?: string;
      matchId?: number;
      voterId?: string;
      songId?: number | null;
    },
    @Req() request: TeamRequest,
  ) {
    return this.scenesService.voteBracket(+id, data, callerTeam(request));
  }

  @Post([':id/bracket/voting/open', ':id/modo-italiano-bracket/voting/open'])
  @RequirePermission(ALCANTARA_PERMISSIONS.scene.operate)
  async openBracketVoting(
    @Param('id') id: string,
    @Body() data: { componentType?: string; matchId?: number },
    @Req() request: TeamRequest,
  ) {
    return this.scenesService.openBracketVoting(+id, data, callerTeam(request));
  }

  @Delete(':id')
  @RequirePermission(ALCANTARA_PERMISSIONS.scene.manage)
  async remove(@Param('id') id: string, @Req() request: TeamRequest) {
    return this.scenesService.remove(+id, callerTeam(request));
  }
}
