import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { Public } from '../auth/public.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { AlanaRecordingClient } from './alana-recording.client';
import { RecordingDownloadTicketService } from './recording-download-ticket.service';
import { normalizeProgramId } from './recording.controller';

type DownloadReply = {
  raw: ServerResponse;
  status(code: number): DownloadReply;
  headers(values: Record<string, string>): DownloadReply;
  send(payload?: unknown): unknown;
};

const RANGE = /^bytes=\d*-\d*$/;

@Controller('program/:programId/recording')
export class RecordingFileController {
  constructor(
    private readonly alana: AlanaRecordingClient,
    private readonly tickets: RecordingDownloadTicketService,
  ) {}

  @Post('download-ticket')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(ALCANTARA_PERMISSIONS.program.operate)
  issue(@Param('programId') programId: string) {
    return this.tickets.issue(normalizeProgramId(programId));
  }

  /**
   * Streams the verified final MP4. Authorization is the short-lived ticket
   * above so a normal browser download (no Authorization header) works.
   */
  @Get('file')
  @Public()
  async file(
    @Param('programId') programId: string,
    @Query('ticket') ticket: string | undefined,
    @Headers('range') range: string | undefined,
    @Res() reply: DownloadReply,
  ): Promise<void> {
    const id = normalizeProgramId(programId);
    if (!this.tickets.validate(ticket, id)) {
      throw new ForbiddenException({ error: 'INVALID_DOWNLOAD_TICKET' });
    }
    const upstream = await this.alana.openRecordingFile(
      id,
      range && RANGE.test(range) ? range : undefined,
    );
    if (upstream.status === 404 || !upstream.body) {
      if (upstream.status === 416) {
        void reply.status(416).headers(upstream.headers).send();
        return;
      }
      throw new NotFoundException({ error: 'RECORDING_FILE_UNAVAILABLE' });
    }
    reply.raw.once('close', upstream.abort);
    void reply
      .status(upstream.status)
      .headers({
        ...upstream.headers,
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      })
      .send(upstream.body);
  }
}
