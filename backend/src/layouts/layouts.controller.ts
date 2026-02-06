import { Controller, Get, Post, Put, Delete, Body, Param } from '@nestjs/common';
import { LayoutsService } from './layouts.service';

@Controller('layouts')
export class LayoutsController {
  constructor(private readonly layoutsService: LayoutsService) {}

  @Get()
  async findAll() {
    return this.layoutsService.findAll();
  }

  @Get('component-types')
  async getComponentTypes() {
    return this.layoutsService.getComponentTypes();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.layoutsService.findOne(+id);
  }

  @Post()
  async create(@Body() data: { name: string; componentType: string; settings?: any }) {
    return this.layoutsService.create(data);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() data: { name?: string; componentType?: string; settings?: any },
  ) {
    return this.layoutsService.update(+id, data);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.layoutsService.remove(+id);
  }
}
