import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { Public } from '../auth/public.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ReturnRouterService } from './return-router.service';
import { WebrtcService } from './webrtc.service';

/** The server-run return router's endpoints. Both take only the renderer key (`X-Renderer-Key`). */
@Controller('webrtc')
@RequirePermission(ALCANTARA_PERMISSIONS.webrtc.read)
export class ReturnRouterController {
  constructor(
    private readonly returns: ReturnRouterService,
    private readonly webrtc: WebrtcService,
  ) {}

  @Get('return-routers')
  @Public()
  @Header('Cache-Control', 'no-store')
  wanted(
    @Headers('x-renderer-key') rendererKey: string | undefined,
    @Query('running') running: unknown,
  ) {
    return this.returns.wantedRouters(rendererKey, running);
  }

  @Post('return-audio-ticket')
  @Public()
  @Header('Cache-Control', 'no-store')
  audioTicket(
    @Headers('x-renderer-key') rendererKey: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    return this.returns.audioTicket(rendererKey, body?.programId);
  }

  /** The guests on air, for the on-air contribution worker beside Palazzo. */
  @Get('on-air')
  @Public()
  @Header('Cache-Control', 'no-store')
  onAir(
    @Headers('x-renderer-key') rendererKey: string | undefined,
    @Query('programId') programId: unknown,
  ) {
    return this.webrtc.onAirGuests(rendererKey, programId);
  }

  /** The call chain's health for the desk (alcantara#877): operator auth, not the renderer key. */
  @Get('health')
  @Header('Cache-Control', 'no-store')
  health(@Query('programId') programId: unknown) {
    return this.returns.health(programId);
  }

  /** The same list pushed as it changes, so the worker puts a cue on air without waiting for its next poll. */
  @Sse('on-air/stream')
  @Public()
  @Header('Cache-Control', 'no-store')
  onAirStream(
    @Headers('x-renderer-key') rendererKey: string | undefined,
    @Query('programId') programId: unknown,
  ): Observable<{ data: string }> {
    return this.webrtc.onAirStream(rendererKey, programId);
  }
}
