import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { MediaGroupsService } from './media-groups.service';

@Controller('media-groups')
export class MediaGroupsController {
  constructor(private readonly mediaGroupsService: MediaGroupsService) {}

  @Get()
  async findAll(
    @Query('search') search?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.mediaGroupsService.findAll({
      search,
      sortBy,
      sortOrder,
      page: page ? Math.max(1, Number(page)) : 1,
      limit: limit ? Math.min(200, Math.max(1, Number(limit))) : 20,
    });
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
