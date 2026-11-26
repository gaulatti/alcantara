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

type TeamRequest = { user: { authorization: { teamId: number } } };

@Controller('scenes')
@RequirePermission(ALCANTARA_PERMISSIONS.scene.read)
export class ScenesController {
  constructor(private readonly scenesService: ScenesService) {}

  @Get()
  async findAll(@Req() request: TeamRequest) {
    return this.scenesService.findAll(request.user.authorization.teamId);
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Req() request: TeamRequest) {
    return this.scenesService.findOne(+id, request.user.authorization.teamId);
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
    return this.scenesService.create(data, request.user.authorization.teamId);
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
    return this.scenesService.update(
      +id,
      data,
      request.user.authorization.teamId,
    );
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
      request.user.authorization.teamId,
    );
  }

  @Post(':id/modo-italiano-bracket/draw')
  @RequirePermission(ALCANTARA_PERMISSIONS.scene.operate)
  async drawModoItalianoBracket(
    @Param('id') id: string,
    @Body() data: { componentType?: string; seed?: number },
    @Req() request: TeamRequest,
  ) {
    return this.scenesService.drawModoItalianoBracket(
      +id,
      data,
      request.user.authorization.teamId,
    );
  }

  @Post(':id/modo-italiano-bracket/vote')
  @RequirePermission(ALCANTARA_PERMISSIONS.scene.operate)
  async voteModoItalianoBracket(
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
    return this.scenesService.voteModoItalianoBracket(
      +id,
      data,
      request.user.authorization.teamId,
    );
  }

  @Post(':id/modo-italiano-bracket/voting/open')
  @RequirePermission(ALCANTARA_PERMISSIONS.scene.operate)
  async openModoItalianoBracketVoting(
    @Param('id') id: string,
    @Body() data: { componentType?: string; matchId?: number },
    @Req() request: TeamRequest,
  ) {
    return this.scenesService.openModoItalianoBracketVoting(
      +id,
      data,
      request.user.authorization.teamId,
    );
  }

  @Delete(':id')
  @RequirePermission(ALCANTARA_PERMISSIONS.scene.manage)
  async remove(@Param('id') id: string, @Req() request: TeamRequest) {
    return this.scenesService.remove(+id, request.user.authorization.teamId);
  }
}
