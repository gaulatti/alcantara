import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ProgramService } from '../program/program.service';

@Controller('instants')
export class InstantsController {
  constructor(private readonly programService: ProgramService) {}

  @Get()
  async listInstants() {
    return this.programService.listInstants();
  }

  @Post()
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
  async deleteInstant(@Param('instantId') instantId: string) {
    return this.programService.deleteInstant(Number(instantId));
  }

  @Post(':instantId/play')
  async playInstant(
    @Param('instantId') instantId: string,
    @Query('programId') programIdQuery?: string,
    @Body() data?: { programId?: string },
  ) {
    const programId = programIdQuery ?? data?.programId;
    return this.programService.playInstant(Number(instantId), programId);
  }

  @Post('stop-all')
  async stopAllInstants(
    @Query('programId') programIdQuery?: string,
    @Body() data?: { programId?: string },
  ) {
    const programId = programIdQuery ?? data?.programId;
    return this.programService.stopAllInstants(programId);
  }
}
