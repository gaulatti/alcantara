import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { MediaGroupsService } from './media-groups.service';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';
import { RendererPublic } from '../auth/renderer-boundary';

@Controller('media-groups')
@RequirePermission(ALCANTARA_PERMISSIONS.media.read)
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
      limit: limit ? Math.max(0, Number(limit)) : 20,
    });
  }

  @Get(':id')
  @RendererPublic('media-group-read')
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
  ) {
    return this.mediaGroupsService.create(data);
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
  ) {
    return this.mediaGroupsService.update(Number(id), data);
  }

  @Delete(':id')
  @RequirePermission(ALCANTARA_PERMISSIONS.media.manage)
  async remove(@Param('id') id: string) {
    return this.mediaGroupsService.remove(Number(id));
  }
}
