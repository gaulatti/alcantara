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

@Controller('scenes')
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
  async updateChyron(
    @Param('id') id: string,
    @Body() data: { chyronText: string },
  ) {
    return this.scenesService.updateChyron(+id, data.chyronText);
  }

  @Post(':id/modo-italiano-bracket/draw')
  async drawModoItalianoBracket(
    @Param('id') id: string,
    @Body() data: { componentType?: string; seed?: number },
  ) {
    return this.scenesService.drawModoItalianoBracket(+id, data);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.scenesService.remove(+id);
  }
}
