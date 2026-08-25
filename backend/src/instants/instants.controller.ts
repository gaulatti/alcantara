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
import { ProgramService } from '../program/program.service';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('instants')
@RequirePermission(ALCANTARA_PERMISSIONS.instant.read)
export class InstantsController {
  constructor(private readonly programService: ProgramService) {}

  @Get()
  async listInstants(@Query('programId') programId?: string) {
    return this.programService.listInstants(programId);
  }

  @Post()
  @RequirePermission(ALCANTARA_PERMISSIONS.instant.manage)
  async createInstant(
    @Body()
    data: {
      name: string;
      audioUrl: string;
      volume?: number;
      enabled?: boolean;
    },
  ) {
    return this.programService.createInstant(data);
  }

  @Put(':instantId')
  @RequirePermission(ALCANTARA_PERMISSIONS.instant.manage)
  async updateInstant(
    @Param('instantId') instantId: string,
    @Body()
    data: {
      name?: string;
      audioUrl?: string;
      volume?: number;
      enabled?: boolean;
    },
  ) {
    return this.programService.updateInstant(Number(instantId), data);
  }

  @Delete(':instantId')
  @RequirePermission(ALCANTARA_PERMISSIONS.instant.manage)
  async deleteInstant(@Param('instantId') instantId: string) {
    return this.programService.deleteInstant(Number(instantId));
  }

  @Post(':instantId/play')
  @RequirePermission(ALCANTARA_PERMISSIONS.instant.operate)
  async playInstant(
    @Param('instantId') instantId: string,
    @Query('programId') programIdQuery?: string,
    @Body() data?: { programId?: string },
  ) {
    const programId = programIdQuery ?? data?.programId;
    return this.programService.playInstant(Number(instantId), programId);
  }

  @Post('stop-all')
  @RequirePermission(ALCANTARA_PERMISSIONS.instant.operate)
  async stopAllInstants(
    @Query('programId') programIdQuery?: string,
    @Body() data?: { programId?: string },
  ) {
    const programId = programIdQuery ?? data?.programId;
    return this.programService.stopAllInstants(programId);
  }
}
