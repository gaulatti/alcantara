import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Put,
  Delete,
} from '@nestjs/common';
import { ScenesService } from './scenes.service';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('scenes')
@RequirePermission(ALCANTARA_PERMISSIONS.scene.read)
export class ScenesController {
  constructor(private readonly scenesService: ScenesService) {}

  @Get()
  async findAll() {
    return this.scenesService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.scenesService.findOne(+id);
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
    },
  ) {
    return this.scenesService.create(data);
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
    },
  ) {
    return this.scenesService.update(+id, data);
  }

  @Put(':id/chyron')
  @RequirePermission(ALCANTARA_PERMISSIONS.scene.operate)
  async updateChyron(
    @Param('id') id: string,
    @Body() data: { chyronText: string },
  ) {
    return this.scenesService.updateChyron(+id, data.chyronText);
  }

  @Post(':id/modo-italiano-bracket/draw')
  @RequirePermission(ALCANTARA_PERMISSIONS.scene.operate)
  async drawModoItalianoBracket(
    @Param('id') id: string,
    @Body() data: { componentType?: string; seed?: number },
  ) {
    return this.scenesService.drawModoItalianoBracket(+id, data);
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
  ) {
    return this.scenesService.voteModoItalianoBracket(+id, data);
  }

  @Post(':id/modo-italiano-bracket/voting/open')
  @RequirePermission(ALCANTARA_PERMISSIONS.scene.operate)
  async openModoItalianoBracketVoting(
    @Param('id') id: string,
    @Body() data: { componentType?: string; matchId?: number },
  ) {
    return this.scenesService.openModoItalianoBracketVoting(+id, data);
  }

  @Delete(':id')
  @RequirePermission(ALCANTARA_PERMISSIONS.scene.manage)
  async remove(@Param('id') id: string) {
    return this.scenesService.remove(+id);
  }
}
