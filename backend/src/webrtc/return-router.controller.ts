import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Post,
  Query,
} from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { Public } from '../auth/public.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ReturnRouterService } from './return-router.service';

/** The server-run return router's endpoints. Both take only the renderer key (`X-Renderer-Key`). */
@Controller('webrtc')
@RequirePermission(ALCANTARA_PERMISSIONS.webrtc.read)
export class ReturnRouterController {
  constructor(private readonly returns: ReturnRouterService) {}

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
}
