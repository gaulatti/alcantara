import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { SongsService } from './songs.service';

@Controller('songs')
export class SongsController {
  constructor(private readonly songsService: SongsService) {}

  @Get()
  async findAll() {
    return this.songsService.findAll();
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
