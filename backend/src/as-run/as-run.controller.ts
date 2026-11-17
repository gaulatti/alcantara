import { Controller, Get, Header, Param, Query, Res } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';
import { AsRunService } from './as-run.service';

export interface AsRunExportReply {
  header?(name: string, value: string): unknown;
}

@Controller('program/:programId/as-run')
@RequirePermission(ALCANTARA_PERMISSIONS.radio.read)
export class AsRunController {
  constructor(private readonly asRunService: AsRunService) {}

  @Get()
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async export(
    @Param('programId') programId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: AsRunExportReply,
    @Query('inferred') inferred?: string,
  ): Promise<string> {
    const rawFormat = format ? format.toLowerCase() : 'csv';
    const result = await this.asRunService.export(programId, {
      from,
      to,
      format,
      inferred,
    });

    if (res && typeof res.header === 'function') {
      res.header(
        'Content-Disposition',
        `attachment; filename="as-run-${programId}-${rawFormat}.csv"`,
      );
    }

    return result;
  }
}
