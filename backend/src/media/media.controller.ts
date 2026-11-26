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
import { MediaService } from './media.service';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';
import { callerTeam, type TeamRequest } from '../tenancy/caller-team';

@Controller('media')
@RequirePermission(ALCANTARA_PERMISSIONS.media.read)
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Get()
  async findAll(
    @Req() request: TeamRequest,
    @Query('search') search?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.mediaService.findAll(
      {
        search,
        sortBy,
        sortOrder,
        page: page ? Math.max(1, Number(page)) : 1,
        limit: limit ? Math.min(200, Math.max(1, Number(limit))) : 50,
      },
      callerTeam(request),
    );
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Req() request: TeamRequest) {
    return this.mediaService.findOne(Number(id), callerTeam(request));
  }

  @Post()
  @RequirePermission(ALCANTARA_PERMISSIONS.media.manage)
  async create(
    @Body()
    data: {
      name?: string;
      imageUrl?: string;
    },
    @Req() request: TeamRequest,
  ) {
    return this.mediaService.create(data, callerTeam(request));
  }

  @Put(':id')
  @RequirePermission(ALCANTARA_PERMISSIONS.media.manage)
  async update(
    @Param('id') id: string,
    @Body()
    data: {
      name?: string;
      imageUrl?: string;
    },
    @Req() request: TeamRequest,
  ) {
    return this.mediaService.update(Number(id), data, callerTeam(request));
  }

  @Delete(':id')
  @RequirePermission(ALCANTARA_PERMISSIONS.media.manage)
  async remove(@Param('id') id: string, @Req() request: TeamRequest) {
    return this.mediaService.remove(Number(id), callerTeam(request));
  }
}
