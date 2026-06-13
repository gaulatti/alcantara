import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { SongsService } from './songs.service';

@Controller('songs')
export class SongsController {
  constructor(private readonly songsService: SongsService) {}

  @Get()
  async findAll(
    @Query('search') search?: string,
    @Query('enabled') enabled?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.songsService.findAll({
      search,
      enabled: enabled === undefined ? undefined : enabled === 'true',
      sortBy,
      sortOrder,
      page: page ? Math.max(1, Number(page)) : 1,
      limit: limit ? Math.max(0, Number(limit)) : 50,
    });
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.songsService.findOne(Number(id));
  }

  @Post()
  async create(
    @Body()
    data: {
      artist?: string;
      title?: string;
      audioUrl?: string;
      coverUrl?: string | null;
      durationMs?: number | null;
      earoneSongId?: string | number | null;
      earoneRank?: string | number | null;
      earoneSpins?: string | number | null;
      enabled?: boolean;
    },
  ) {
    return this.songsService.create(data);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body()
    data: {
      artist?: string;
      title?: string;
      audioUrl?: string;
      coverUrl?: string | null;
      durationMs?: number | null;
      earoneSongId?: string | number | null;
      earoneRank?: string | number | null;
      earoneSpins?: string | number | null;
      enabled?: boolean;
    },
  ) {
    return this.songsService.update(Number(id), data);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.songsService.remove(Number(id));
  }
}
