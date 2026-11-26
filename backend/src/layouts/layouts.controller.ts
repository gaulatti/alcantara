import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Req,
} from '@nestjs/common';
import { LayoutsService } from './layouts.service';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';
import { callerTeam, type TeamRequest } from '../tenancy/caller-team';

@Controller('layouts')
@RequirePermission(ALCANTARA_PERMISSIONS.layout.read)
export class LayoutsController {
  constructor(private readonly layoutsService: LayoutsService) {}

  @Get()
  async findAll(@Req() request: TeamRequest) {
    return this.layoutsService.findAll(callerTeam(request));
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Req() request: TeamRequest) {
    return this.layoutsService.findOne(+id, callerTeam(request));
  }

  @Post()
  @RequirePermission(ALCANTARA_PERMISSIONS.layout.manage)
  async create(
    @Body() data: { name: string; componentType: string; settings?: any },
    @Req() request: TeamRequest,
  ) {
    return this.layoutsService.create(data, callerTeam(request));
  }

  @Put(':id')
  @RequirePermission(ALCANTARA_PERMISSIONS.layout.manage)
  async update(
    @Param('id') id: string,
    @Body() data: { name?: string; componentType?: string; settings?: any },
    @Req() request: TeamRequest,
  ) {
    return this.layoutsService.update(+id, data, callerTeam(request));
  }

  @Delete(':id')
  @RequirePermission(ALCANTARA_PERMISSIONS.layout.manage)
  async remove(@Param('id') id: string, @Req() request: TeamRequest) {
    return this.layoutsService.remove(+id, callerTeam(request));
  }
}
