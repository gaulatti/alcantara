import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { PompeiiAuthorizationGuard } from './pompeii-authorization.guard';
import { PompeiiService } from './pompeii.service';
import { RealtimeTicketService } from './realtime-ticket.service';

@Global()
@Module({
  imports: [ConfigModule],
  controllers: [AuthController],
  providers: [
    PompeiiService,
    RealtimeTicketService,
    { provide: APP_GUARD, useClass: PompeiiAuthorizationGuard },
  ],
  exports: [PompeiiService, RealtimeTicketService],
})
export class AuthModule {}
