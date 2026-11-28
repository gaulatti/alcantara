import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';
import {
  RadioDaypartsService,
  type RadioDaypartInput,
} from './radio-dayparts.service';

/** gaulatti/alcantara#124: a radio program's weekly daypart grid, read and saved whole. */
@Controller('program')
export class RadioDaypartsController {
  constructor(private readonly dayparts: RadioDaypartsService) {}

  @Get(':programId/radio-dayparts')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.read)
  async getRadioDayparts(@Param('programId') programId: string) {
    return this.dayparts.get(programId);
  }

  @Put(':programId/radio-dayparts')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.manage)
  async saveRadioDayparts(
    @Param('programId') programId: string,
    @Body() body: RadioDaypartInput,
  ) {
    return this.dayparts.save(programId, body ?? {});
  }
}
