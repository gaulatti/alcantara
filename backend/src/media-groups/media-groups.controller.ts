import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { MediaGroupsService } from './media-groups.service';

@Controller('media-groups')
export class MediaGroupsController {
  constructor(private readonly mediaGroupsService: MediaGroupsService) {}

  @Get()
  async findAll() {
    return this.mediaGroupsService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.mediaGroupsService.findOne(Number(id));
  }

  @Post()
  async create(
    @Body()
    data: {
      name?: string;
      description?: string | null;
      mediaIds?: number[];
    },
  ) {
    return this.mediaGroupsService.create(data);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body()
    data: {
      name?: string;
      description?: string | null;
      mediaIds?: number[];
    },
  ) {
    return this.mediaGroupsService.update(Number(id), data);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.mediaGroupsService.remove(Number(id));
  }
}
