import {
  BadRequestException,
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

const COMMAND_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

@Controller('program/:programId/recording')
@RequirePermission(ALCANTARA_PERMISSIONS.program.read)
export class RecordingController {
  constructor(private readonly recording: AlanaRecordingClient) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  status(@Param('programId') programId: string) {
    return this.recording.status(normalizeProgramId(programId));
  }

  @Post('start')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission(ALCANTARA_PERMISSIONS.program.operate)
  start(
    @Param('programId') programId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.recording.command(
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
    return this.recording.command(
      normalizeProgramId(programId),
      'stop',
      normalizeCommandKey(idempotencyKey),
    );
  }
}

function normalizeProgramId(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 200 ||
    normalized.includes('/') ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new BadRequestException({ error: 'INVALID_PROGRAM_ID' });
  }
  return normalized;
}

function normalizeCommandKey(value?: string): string {
  const normalized = value?.trim() ?? '';
  if (!COMMAND_KEY.test(normalized)) {
    throw new BadRequestException({
      error: 'A_BOUNDED_IDEMPOTENCY_KEY_IS_REQUIRED',
    });
  }
  return normalized;
}
