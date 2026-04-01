import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { MediaService } from './media.service';

@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Get()
  async findAll() {
    return this.mediaService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.mediaService.findOne(Number(id));
  }

  @Post()
  async create(
    @Body()
    data: {
      name?: string;
      imageUrl?: string;
    },
  ) {
    return this.mediaService.create(data);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body()
    data: {
      name?: string;
      imageUrl?: string;
    },
  ) {
    return this.mediaService.update(Number(id), data);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.mediaService.remove(Number(id));
  }
}
