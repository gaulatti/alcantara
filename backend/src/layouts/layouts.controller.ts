import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
} from '@nestjs/common';
import { LayoutsService } from './layouts.service';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('layouts')
@RequirePermission(ALCANTARA_PERMISSIONS.layout.read)
export class LayoutsController {
  constructor(private readonly layoutsService: LayoutsService) {}

  @Get()
  async findAll() {
    return this.layoutsService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.layoutsService.findOne(+id);
  }

  @Post()
  @RequirePermission(ALCANTARA_PERMISSIONS.layout.manage)
  async create(
    @Body() data: { name: string; componentType: string; settings?: any },
  ) {
    return this.layoutsService.create(data);
  }

  @Put(':id')
  @RequirePermission(ALCANTARA_PERMISSIONS.layout.manage)
  async update(
    @Param('id') id: string,
    @Body() data: { name?: string; componentType?: string; settings?: any },
  ) {
    return this.layoutsService.update(+id, data);
  }

  @Delete(':id')
  @RequirePermission(ALCANTARA_PERMISSIONS.layout.manage)
  async remove(@Param('id') id: string) {
    return this.layoutsService.remove(+id);
  }
}
