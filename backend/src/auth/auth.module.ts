import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { MCP_ATTRIBUTION } from '../mcp/contract';
import { ActorContextInterceptor } from './actor-context.interceptor';
import { McpActorAttribution } from './mcp-actor-attribution';
import { AuthController } from './auth.controller';
import { PompeiiAuthorizationGuard } from './pompeii-authorization.guard';
import { PompeiiService } from './pompeii.service';
import { RealtimeTicketService } from './realtime-ticket.service';
import { TestAuthController } from './test-auth.controller';
import { TestAuthService } from './test-auth.service';

@Global()
@Module({
  imports: [ConfigModule],
  controllers: [AuthController, TestAuthController],
  providers: [
    PompeiiService,
    RealtimeTicketService,
    TestAuthService,
    { provide: APP_GUARD, useClass: PompeiiAuthorizationGuard },
    { provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor },
    { provide: MCP_ATTRIBUTION, useClass: McpActorAttribution },
  ],
  exports: [
    PompeiiService,
    RealtimeTicketService,
    TestAuthService,
    MCP_ATTRIBUTION,
  ],
})
export class AuthModule {}
