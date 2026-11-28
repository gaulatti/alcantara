import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';
import {
  RadioClocksService,
  type RadioClockInput,
} from './radio-clocks.service';

/** gaulatti/alcantara#124: a radio program's clocks, with the permissions radio log generation already needs. */
@Controller('program')
export class RadioClocksController {
  constructor(private readonly clocks: RadioClocksService) {}

  @Get(':programId/radio-clocks')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.read)
  async listRadioClocks(@Param('programId') programId: string) {
    return this.clocks.list(programId);
  }

  @Post(':programId/radio-clocks')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.manage)
  async createRadioClock(
    @Param('programId') programId: string,
    @Body() body: RadioClockInput,
  ) {
    return this.clocks.create(programId, body ?? {});
  }

  @Put(':programId/radio-clocks/:clockId')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.manage)
  async updateRadioClock(
    @Param('programId') programId: string,
    @Param('clockId', ParseIntPipe) clockId: number,
    @Body() body: RadioClockInput,
  ) {
    return this.clocks.update(programId, clockId, body ?? {});
  }

  @Delete(':programId/radio-clocks/:clockId')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.manage)
  async deleteRadioClock(
    @Param('programId') programId: string,
    @Param('clockId', ParseIntPipe) clockId: number,
    @Query('revision', ParseIntPipe) revision: number,
  ) {
    return this.clocks.delete(programId, clockId, revision);
  }
}
