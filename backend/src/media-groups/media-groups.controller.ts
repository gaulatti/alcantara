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
import { MediaGroupsService } from './media-groups.service';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { Public } from '../auth/public.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { callerTeam, type TeamRequest } from '../tenancy/caller-team';

@Controller('media-groups')
@RequirePermission(ALCANTARA_PERMISSIONS.media.read)
export class MediaGroupsController {
  constructor(private readonly mediaGroupsService: MediaGroupsService) {}

  @Get()
  async findAll(
    @Req() request: TeamRequest,
    @Query('search') search?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.mediaGroupsService.findAll(
      {
        search,
        sortBy,
        sortOrder,
        page: page ? Math.max(1, Number(page)) : 1,
        limit: limit ? Math.max(0, Number(limit)) : 20,
      },
      callerTeam(request),
    );
  }

  @Get(':id')
  @Public()
  async findOne(@Param('id') id: string) {
    return this.mediaGroupsService.findOne(Number(id));
  }

  @Post()
  @RequirePermission(ALCANTARA_PERMISSIONS.media.manage)
  async create(
    @Body()
    data: {
      name?: string;
      description?: string | null;
      mediaIds?: number[];
    },
    @Req() request: TeamRequest,
  ) {
    return this.mediaGroupsService.create(data, callerTeam(request));
  }

  @Put(':id')
  @RequirePermission(ALCANTARA_PERMISSIONS.media.manage)
  async update(
    @Param('id') id: string,
    @Body()
    data: {
      name?: string;
      description?: string | null;
      mediaIds?: number[];
    },
    @Req() request: TeamRequest,
  ) {
    return this.mediaGroupsService.update(
      Number(id),
      data,
      callerTeam(request),
    );
  }

  @Delete(':id')
  @RequirePermission(ALCANTARA_PERMISSIONS.media.manage)
  async remove(@Param('id') id: string, @Req() request: TeamRequest) {
    return this.mediaGroupsService.remove(Number(id), callerTeam(request));
  }
}
