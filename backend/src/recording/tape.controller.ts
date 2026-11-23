import {
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';
import { AlanaRecordingClient } from './alana-recording.client';
import {
  normalizeCommandKey,
  normalizeProgramId,
} from './recording.controller';

@Controller('program/:programId/tape')
@RequirePermission(ALCANTARA_PERMISSIONS.program.read)
export class TapeController {
  constructor(private readonly alana: AlanaRecordingClient) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  status(@Param('programId') programId: string) {
    return this.alana.tapeStatus(normalizeProgramId(programId));
  }

  @Post('start')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission(ALCANTARA_PERMISSIONS.program.operate)
  start(
    @Param('programId') programId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.alana.tapeCommand(
      normalizeProgramId(programId),
      'start',
      normalizeCommandKey(idempotencyKey),
    );
  }

  @Post('stop')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(ALCANTARA_PERMISSIONS.program.operate)
  stop(
    @Param('programId') programId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.alana.tapeCommand(
      normalizeProgramId(programId),
      'stop',
      normalizeCommandKey(idempotencyKey),
    );
  }
}
