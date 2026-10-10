import {
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { Public } from '../auth/public.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RadioMonitorService } from './radio-monitor.service';

@Controller('radio')
export class RadioMonitorController {
  constructor(private readonly monitor: RadioMonitorService) {}

  @Post(':programId/monitor-ticket')
  @Header('Cache-Control', 'no-store')
  @RequirePermission(ALCANTARA_PERMISSIONS.radio.read)
  issue(@Param('programId') programId: string) {
    return this.monitor.issue(programId);
  }

  @Get(':programId/monitor-audio')
  @Public()
  @Header('Cache-Control', 'no-store')
  @Header('X-Accel-Buffering', 'no')
  async audio(
    @Param('programId') programId: string,
    @Query('ticket') ticket: string,
    @Res({ passthrough: true }) reply: { raw: ServerResponse },
  ): Promise<StreamableFile> {
    const abort = new AbortController();
    const close = () => abort.abort();
    reply.raw.once('close', close);
    try {
      const output = await this.monitor.open(programId, ticket, abort.signal);
      output.stream.once('close', () =>
        reply.raw.removeListener('close', close),
      );
      return new StreamableFile(output.stream, { type: output.type });
    } catch (error) {
      reply.raw.removeListener('close', close);
      throw error;
    }
  }
}
