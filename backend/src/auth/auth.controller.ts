import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from './permissions';
import { RequirePermission } from './require-permission.decorator';
import { RealtimeTicketService } from './realtime-ticket.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly realtimeTickets: RealtimeTicketService) {}

  @Get('me')
  @RequirePermission(ALCANTARA_PERMISSIONS.access)
  getMe(
    @Req()
    req: {
      user: {
        sub: string;
        authorization?: {
          permission: string;
          permissions: string[];
          roles: string[];
          teamId: number;
        };
      };
    },
  ) {
    return req.user;
  }

  @Post('realtime-ticket')
  @RequirePermission(ALCANTARA_PERMISSIONS.program.read)
  issueRealtimeTicket(@Body() body: { programId?: unknown }) {
    const programId =
      typeof body.programId === 'string' ? body.programId : 'main';
    return this.realtimeTickets.issue(programId);
  }
}
