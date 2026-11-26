import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { SongsService } from './songs.service';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';
import { callerTeam, type TeamRequest } from '../tenancy/caller-team';

@Controller('songs')
@RequirePermission(ALCANTARA_PERMISSIONS.song.read)
export class SongsController {
  constructor(private readonly songsService: SongsService) {}

  @Get()
  async findAll(
    @Req() request: TeamRequest,
    @Query('search') search?: string,
    @Query('enabled') enabled?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('programId') programId?: string,
  ) {
    return this.songsService.findAll(
      {
        search,
        enabled: enabled === undefined ? undefined : enabled === 'true',
        sortBy,
        sortOrder,
        page: page ? Math.max(1, Number(page)) : 1,
        limit: limit ? Math.max(0, Number(limit)) : 50,
        programId,
      },
      callerTeam(request),
    );
  }

  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @Req() request: TeamRequest,
    @Query('programId') programId?: string,
  ) {
    return this.songsService.findOne(
      Number(id),
      programId,
      callerTeam(request),
    );
  }

  @Post()
  @RequirePermission(ALCANTARA_PERMISSIONS.song.manage)
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
      externalChartId?: string | number | null;
      externalChartSongId?: string | number | null;
      externalChartRank?: string | number | null;
      externalChartSpins?: string | number | null;
      externalChartProvider?: string | null;
      enabled?: boolean;
      programId?: string;
      introInstantId?: number | null;
    },
    @Req() request: TeamRequest,
  ) {
    return this.songsService.create(data, callerTeam(request));
  }

  @Put(':id')
  @RequirePermission(ALCANTARA_PERMISSIONS.song.manage)
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
      externalChartId?: string | number | null;
      externalChartSongId?: string | number | null;
      externalChartRank?: string | number | null;
      externalChartSpins?: string | number | null;
      externalChartProvider?: string | null;
      enabled?: boolean;
      programId?: string;
      introInstantId?: number | null;
    },
    @Req() request: TeamRequest,
  ) {
    return this.songsService.update(Number(id), data, callerTeam(request));
  }

  @Delete(':id')
  @RequirePermission(ALCANTARA_PERMISSIONS.song.manage)
  async remove(@Param('id') id: string, @Req() request: TeamRequest) {
    return this.songsService.remove(Number(id), callerTeam(request));
  }
}
