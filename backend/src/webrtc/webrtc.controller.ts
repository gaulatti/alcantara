import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { Public } from '../auth/public.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { WebrtcService } from './webrtc.service';

type OperatorRequest = { user: { sub: string } };

@Controller('webrtc')
@RequirePermission(ALCANTARA_PERMISSIONS.webrtc.read)
export class WebrtcController {
  constructor(private readonly webrtc: WebrtcService) {}

  @Get('config')
  @Public()
  config() {
    return this.webrtc.getPublicConfig();
  }

  @Get('invitations')
  listInvitations() {
    return this.webrtc.listInvitations();
  }

  @Post('invitations')
  @RequirePermission(ALCANTARA_PERMISSIONS.webrtc.operate)
  createInvitation(
    @Req() request: OperatorRequest,
    @Body() body: Record<string, unknown>,
  ) {
    return this.webrtc.createInvitation(request.user.sub, body);
  }

  @Post('invitations/:id/replace')
  @RequirePermission(ALCANTARA_PERMISSIONS.webrtc.operate)
  replaceInvitation(@Req() request: OperatorRequest, @Param('id') id: string) {
    return this.webrtc.replaceInvitation(request.user.sub, id);
  }

  @Delete('invitations/:id')
  @RequirePermission(ALCANTARA_PERMISSIONS.webrtc.operate)
  revokeInvitation(@Req() request: OperatorRequest, @Param('id') id: string) {
    return this.webrtc.revokeInvitation(request.user.sub, id);
  }

  @Patch('invitations/:id/return')
  @RequirePermission(ALCANTARA_PERMISSIONS.webrtc.operate)
  updateReturn(
    @Req() request: OperatorRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.webrtc.updateReturn(request.user.sub, id, body);
  }

  @Post('join')
  @Public()
  join(@Body() body: Record<string, unknown>) {
    return this.webrtc.redeemInvitation(body.invitation, body.sessionToken);
  }

  @Post('session/heartbeat')
  @Public()
  heartbeat(@Body() body: Record<string, unknown>) {
    return this.webrtc.heartbeat(body.sessionToken, body.telemetry);
  }

  @Post('commands/:commandId/ack')
  @Public()
  acknowledge(
    @Param('commandId') commandId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.webrtc.acknowledgeCommand(
      body.sessionToken,
      commandId,
      body.status,
    );
  }

  @Get('rooms/:programId/participants')
  listParticipants(@Param('programId') programId: string) {
    return this.webrtc.listParticipants(programId);
  }

  @Post('operator-token')
  @RequirePermission(ALCANTARA_PERMISSIONS.webrtc.operate)
  operatorToken(
    @Req() request: OperatorRequest,
    @Body() body: Record<string, unknown>,
  ) {
    return this.webrtc.createOperatorToken(request.user.sub, body.programId);
  }

  @Post('rooms/:programId/participants/:identity/control')
  @RequirePermission(ALCANTARA_PERMISSIONS.webrtc.operate)
  controlParticipant(
    @Param('programId') programId: string,
    @Param('identity') identity: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.webrtc.controlParticipant(programId, identity, body);
  }

  @Delete('rooms/:programId/participants/:identity')
  @RequirePermission(ALCANTARA_PERMISSIONS.webrtc.operate)
  removeParticipant(
    @Req() request: OperatorRequest,
    @Param('programId') programId: string,
    @Param('identity') identity: string,
  ) {
    return this.webrtc.removeParticipant(request.user.sub, programId, identity);
  }

  @Post('renderer-token')
  @Public()
  rendererToken(
    @Headers('x-renderer-key') rendererKey: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    return this.webrtc.createRendererToken(rendererKey, body.programId);
  }

  @Post('renderer-state')
  @Public()
  rendererState(
    @Headers('x-renderer-key') rendererKey: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    return this.webrtc.getRendererState(rendererKey, body.programId);
  }

  @Post('renderer-source-token')
  @Public()
  rendererSourceToken(
    @Headers('x-renderer-key') rendererKey: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    return this.webrtc.createRendererSourceToken(rendererKey, body.programId);
  }
}
