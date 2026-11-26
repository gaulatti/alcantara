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
import { ProgramService } from '../program/program.service';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';

type TeamRequest = { user: { authorization: { teamId: number } } };

@Controller('instants')
@RequirePermission(ALCANTARA_PERMISSIONS.instant.read)
export class InstantsController {
  constructor(private readonly programService: ProgramService) {}

  @Get()
  async listInstants(
    @Req() request: TeamRequest,
    @Query('programId') programId?: string,
  ) {
    return this.programService.listInstants(
      programId,
      request.user.authorization.teamId,
    );
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
    @Req() request: TeamRequest,
  ) {
    return this.programService.createInstant(
      data,
      request.user.authorization.teamId,
    );
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
    @Req() request: TeamRequest,
  ) {
    return this.programService.updateInstant(
      Number(instantId),
      data,
      request.user.authorization.teamId,
    );
  }

  @Delete(':instantId')
  @RequirePermission(ALCANTARA_PERMISSIONS.instant.manage)
  async deleteInstant(
    @Param('instantId') instantId: string,
    @Req() request: TeamRequest,
  ) {
    return this.programService.deleteInstant(
      Number(instantId),
      request.user.authorization.teamId,
    );
  }

  @Post(':instantId/play')
  @RequirePermission(ALCANTARA_PERMISSIONS.instant.operate)
  async playInstant(
    @Param('instantId') instantId: string,
    @Req() request: TeamRequest,
    @Query('programId') programIdQuery?: string,
    @Body() data?: { programId?: string },
  ) {
    const programId = programIdQuery ?? data?.programId;
    return this.programService.playInstant(
      Number(instantId),
      programId,
      request.user.authorization.teamId,
    );
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
